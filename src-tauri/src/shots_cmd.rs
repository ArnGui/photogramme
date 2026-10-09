//! Plans : analyse du film, coupes importées d'une liste de montage,
//! coupes ajoutées à la main, code-barre.

use crate::jobs::{run_analysis, JobEvent};
use crate::runner::ProcessGroup;
use crate::state::{lock, AppState, StoredAnalysis};
use photogramme_core::analysis::{Analysis, Decoder};
use photogramme_core::cuts::{self, ImportedCuts};
use photogramme_core::naming::{film_stem, unique_path};
use photogramme_core::pick::pick_in_span;
use photogramme_core::{barcode, encode_rgb, shots, CaptureResult, Chroma};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSummary {
    id: u64,
    frames: u64,
    decoder: Decoder,
    note: Option<String>,
    seconds: f64,
    thumbs: usize,
    thumb_width: u32,
    thumb_height: u32,
    memory_mb: f64,
}

/// Passe d'analyse du film entier (GPU si possible). Progression sur `on_event`.
#[tauri::command]
pub async fn analyze(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<JobEvent>,
) -> Result<AnalysisSummary, String> {
    let info = state.video()?;
    let pref = state.settings()?.shots.decoder;
    let group = ProcessGroup::default();
    {
        let mut g = lock(&state.analysis_group)?;
        if let Some(old) = g.replace(group.clone()) {
            old.cancel();
        }
    }
    let t0 = std::time::Instant::now();
    let res = run_analysis(&app, &info, pref, &group, |done, total, d| {
        let phase = if d == Decoder::Gpu {
            "analysis-gpu"
        } else {
            "analysis-cpu"
        };
        let _ = on_event.send(JobEvent::Progress { phase, done, total });
    })
    .await;
    {
        let mut g = lock(&state.analysis_group)?;
        if g.as_ref().is_some_and(|x| x.same(&group)) {
            *g = None;
        }
    }
    let (data, note) = res?;
    if state.video()?.path != info.path {
        return Err("The film changed during the analysis.".into());
    }
    let id = state.new_id();
    let sum = summary(id, &data, note, t0.elapsed().as_secs_f64());
    let stored = Arc::new(StoredAnalysis {
        id,
        path: info.path,
        data,
    });
    *lock(&state.analysis)? = Some(stored.clone());
    crate::project_cmd::save_analysis(&state, stored);
    Ok(sum)
}

/// Résumé envoyé à l'interface (analyse faite ou reprise d'un projet).
pub fn summary(id: u64, data: &Analysis, note: Option<String>, seconds: f64) -> AnalysisSummary {
    AnalysisSummary {
        id,
        frames: data.frames,
        decoder: data.decoder,
        note,
        seconds,
        thumbs: data.thumbs.len(),
        thumb_width: data.geometry.thumb_w,
        thumb_height: data.geometry.thumb_h,
        memory_mb: data.memory_bytes() as f64 / 1_048_576.0,
    }
}

#[tauri::command]
pub fn cancel_analysis(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(g) = lock(&state.analysis_group)?.take() {
        g.cancel();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotView {
    index: u32,
    start: u64,
    end: u64,
    /// Score de la coupe (−1 : coupe ajoutée à la main ou importée).
    score: f32,
    /// Image dont la vignette représente le plan (`None` sans analyse).
    thumb: Option<u64>,
    clip: Option<String>,
}

/// D'où viennent les coupes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShotSource {
    /// Détection `scdet` (analyse du film).
    Detect,
    /// Liste de montage importée.
    Imported,
}

/// Découpe en plans (instantané : l'analyse et les coupes sont en mémoire).
/// `extra_cuts` : coupes ajoutées à la main sur la tête de lecture.
#[tauri::command]
pub fn list_shots(
    state: State<'_, AppState>,
    source: ShotSource,
    threshold: f32,
    min_seconds: f32,
    extra_cuts: Vec<u64>,
) -> Result<Vec<ShotView>, String> {
    let info = state.video()?;
    let analysis = state.analysis_for(&info.path);
    let imported = state.cuts();
    let pick = state.settings()?.shots.pick;
    let extra: Vec<u64> = extra_cuts.into_iter().take(10_000).collect();
    let list = match source {
        ShotSource::Detect => {
            let a = analysis.as_ref().ok_or("Analyze the film first.")?;
            let min_len = ((min_seconds.max(0.0) as f64) * info.fps).round().max(1.0) as u64;
            shots::detect_with(&a.data.scores, a.data.frames, threshold, min_len, &extra)
        }
        ShotSource::Imported => {
            let c = imported.as_ref().ok_or("Import an edit list first.")?;
            shots::from_cuts(&c.cuts, info.frame_count, &extra)
        }
    };
    Ok(list
        .into_iter()
        .map(|s| {
            let target = pick_in_span(s.start, s.end, pick)
                .first()
                .copied()
                .unwrap_or(s.start);
            ShotView {
                index: s.index,
                start: s.start,
                end: s.end,
                score: s.score,
                thumb: analysis
                    .as_ref()
                    .and_then(|a| a.data.nearest_thumb(target, s.start, s.end)),
                clip: imported
                    .as_ref()
                    .and_then(|c| c.name_at(s.start).map(str::to_string)),
            }
        })
        .collect())
}

/// Ouvre une liste de montage (EDL, OTIO, XML, FCPXML) et la cale sur le film.
#[tauri::command]
pub async fn import_cuts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ImportedCuts>, String> {
    let info = state.video()?;
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a
            .dialog()
            .file()
            .set_title("Import the cuts of an edit")
            .add_filter("Edit list", &["edl", "otio", "xml", "fcpxml"]);
        if let Some(w) = a.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let imported = tauri::async_runtime::spawn_blocking(move || read_edit_list(&path, &info))
        .await
        .map_err(|e| e.to_string())??;
    if state.video()?.path != imported.1 {
        return Err("The film changed during the import.".into());
    }
    *lock(&state.cuts)? = Some(Arc::new(imported.0.clone()));
    crate::project_cmd::save_cuts(&state, &state.video()?, Some(&imported.0));
    Ok(Some(imported.0))
}

fn read_edit_list(
    path: &std::path::Path,
    info: &photogramme_core::VideoInfo,
) -> Result<(ImportedCuts, String), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot read the file: {e}"))?;
    if meta.len() > cuts::MAX_FILE_BYTES {
        return Err("This edit list is too large (20 MB maximum).".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read the file: {e}"))?;
    // Les EDL de certains logiciels sont en Latin-1 : on ne bloque pas sur l'encodage.
    let text =
        String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let list = cuts::parse_edit_list(&name, &text)?;
    Ok((cuts::map_to_film(list, info, &name)?, info.path.clone()))
}

#[tauri::command]
pub fn clear_cuts(state: State<'_, AppState>) -> Result<(), String> {
    *lock(&state.cuts)? = None;
    if let Ok(info) = state.video() {
        crate::project_cmd::save_cuts(&state, &info, None);
    }
    Ok(())
}

/// Réponse du protocole `thumb://` : /{id d'analyse}-{image} (vignette exacte)
/// ou /{id d'analyse}-n{image} (vignette la plus proche, pour la bande d'images).
pub fn thumb_response(
    analysis: Option<Arc<StoredAnalysis>>,
    path: &str,
) -> tauri::http::Response<Vec<u8>> {
    let parts: Vec<&str> = path.trim_matches('/').split('-').collect();
    let (id, frame, near) = match parts.as_slice() {
        [a, b] => match b.strip_prefix('n') {
            Some(n) => (a.parse::<u64>().ok(), n.parse::<u64>().ok(), true),
            None => (a.parse::<u64>().ok(), b.parse::<u64>().ok(), false),
        },
        _ => (None, None, false),
    };
    let found = match (analysis, id, frame) {
        (Some(a), Some(id), Some(f)) if a.id == id => {
            let key = if near {
                a.data.nearest_thumb(f, f, f.saturating_add(1))
            } else {
                Some(f)
            };
            key.and_then(|k| a.data.thumbs.get(&k).cloned())
        }
        _ => None,
    };
    let b = tauri::http::Response::builder();
    match found {
        Some(jpg) => b
            .status(200)
            .header("Content-Type", "image/jpeg")
            // L'URL contient l'identifiant d'analyse : contenu immuable.
            .header("Cache-Control", "max-age=31536000, immutable")
            .body(jpg),
        None => b.status(404).body(Vec::new()),
    }
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn render_barcode(
    a: &Analysis,
    w: u32,
    h: u32,
    mode: barcode::BarcodeMode,
) -> Result<Vec<u8>, String> {
    let rgb = barcode::render(
        &a.columns,
        a.geometry.thumb_h as usize,
        a.frames,
        w,
        h,
        mode,
    )?;
    encode_rgb(&rgb, w, h, 92, Chroma::C444, false)
}

/// Aperçu du code-barre (JPEG) pour la bande au-dessus de la timeline.
#[tauri::command]
pub async fn barcode_preview(
    state: State<'_, AppState>,
    width: u32,
    height: u32,
    mode: barcode::BarcodeMode,
) -> Result<Response, String> {
    let a = state.analysis()?;
    let (w, h) = (width.clamp(16, 4096), height.clamp(4, 512));
    let jpg = tauri::async_runtime::spawn_blocking(move || render_barcode(&a.data, w, h, mode))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(jpg))
}

/// Exporte le code-barre en JPEG pleine taille dans le dossier de sortie.
#[tauri::command]
pub async fn export_barcode(state: State<'_, AppState>) -> Result<CaptureResult, String> {
    let a = state.analysis()?;
    let info = state.video()?;
    let s = state.settings()?;
    let dir = PathBuf::from(
        s.output_dir
            .clone()
            .ok_or("Choose an output folder first.")?,
    );
    tauri::async_runtime::spawn_blocking(move || {
        let b = &s.barcode;
        let jpg = render_barcode(&a.data, b.width, b.height, b.mode)?;
        let path = unique_path(&dir, &format!("{}_barcode.jpg", film_stem(&info.file_name)));
        photogramme_core::capture::write_new_file(&path, &jpg)?;
        Ok(CaptureResult {
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            frame: 0,
            timecode: info.tc(0),
            bytes: jpg.len() as u64,
            width: b.width,
            height: b.height,
            quality: 92,
            shot: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
