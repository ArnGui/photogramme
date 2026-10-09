//! Images à l'unité : capture, image exacte pour l'aperçu, composition
//! renvoyée par l'interface, palette, vérification de la synchro.

use crate::jobs::tool;
use crate::runner::run_raw;
use crate::state::{lock, AppState};
use photogramme_core::color::convert_in_place;
use photogramme_core::naming::{film_stem, tc_for_file, unique_path};
use photogramme_core::{
    capture_args, capture_args_fmt, capture_args_sized, capture_converted, capture_from_rgba,
    dominant_colors, packet, swatches, CaptureResult, Settings, Swatch, VideoInfo,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

/// En-tête des images envoyées à l'interface pour composition.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHeader {
    pub frame: u64,
    pub timecode: String,
    pub width: u32,
    pub height: u32,
    pub palette: Vec<Swatch>,
    pub shot: Option<u32>,
    /// Nom du clip (liste de montage importée).
    pub clip: Option<String>,
    pub job: Option<u64>,
    /// Images à tirer au total (export en lot), pour la progression.
    pub total: Option<usize>,
}

/// Palette des pixels déjà convertis (ce qui sera écrit dans le fichier).
pub fn palette_of(settings: &Settings, px: &[u8], w: u32, h: u32, bpp: usize) -> Vec<Swatch> {
    dominant_colors(px, w, h, bpp, &settings.palette)
}

/// Capture l'image `frame`, sans overlay.
#[tauri::command]
pub async fn capture(
    app: AppHandle,
    state: State<'_, AppState>,
    frame: u64,
) -> Result<CaptureResult, String> {
    let info = state.video()?;
    let settings = state.settings()?;
    let out_dir = settings
        .output_dir
        .clone()
        .ok_or("Choose an output folder first.")?;
    let frame = frame.min(info.frame_count.saturating_sub(1));
    let raw = run_raw(
        tool(&app, "ffmpeg")?.args(capture_args(&info, frame)),
        "ffmpeg",
    )
    .await?;
    // L'encodage d'une image 4K prend quelques dizaines de ms : hors du thread async.
    tauri::async_runtime::spawn_blocking(move || {
        let mut px = raw;
        convert_in_place(&mut px, 3, settings.export.color);
        capture_converted(&info, frame, None, &px, &settings, Path::new(&out_dir))
    })
    .await
    .map_err(|e| format!("Encoding task interrupted: {e}"))?
}

/// Image exacte `frame` en RVBA (convertie selon le profil d'export) +
/// palette : base de l'aperçu d'export, des scopes et de la référence A/B.
#[tauri::command]
pub async fn grab_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    frame: u64,
) -> Result<Response, String> {
    let info = state.video()?;
    let settings = state.settings()?;
    let clip = state
        .cuts()
        .and_then(|c| c.name_at(frame).map(str::to_string));
    let frame = frame.min(info.frame_count.saturating_sub(1));
    let mut rgba = run_raw(
        tool(&app, "ffmpeg")?.args(capture_args_fmt(&info, frame, "rgba")),
        "ffmpeg",
    )
    .await?;
    if rgba.len() != info.out_width as usize * info.out_height as usize * 4 {
        return Err(format!("Incomplete frame: {} bytes received.", rgba.len()));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        convert_in_place(&mut rgba, 4, settings.export.color);
        let palette = palette_of(&settings, &rgba, info.out_width, info.out_height, 4);
        let h = FrameHeader {
            frame,
            timecode: info.tc(frame),
            width: info.out_width,
            height: info.out_height,
            palette,
            shot: None,
            clip,
            job: None,
            total: None,
        };
        packet::encode(&h, &rgba)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Petite image brute (sans conversion) pour vérifier que la visionneuse
/// affiche bien l'image `frame` : l'interface la compare à ce qu'elle montre.
#[tauri::command]
pub async fn grab_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    frame: u64,
    width: u32,
) -> Result<Response, String> {
    let info = state.video()?;
    let frame = frame.min(info.frame_count.saturating_sub(1));
    let (w, h) = photogramme_core::ffargs::fit_width(&info, width.clamp(16, 640));
    let rgba = run_raw(
        tool(&app, "ffmpeg")?.args(capture_args_sized(&info, frame, "rgba", w, h)),
        "ffmpeg",
    )
    .await?;
    if rgba.len() != (w * h * 4) as usize {
        return Err("Incomplete frame.".into());
    }
    #[derive(Serialize)]
    struct H {
        frame: u64,
        timecode: String,
        width: u32,
        height: u32,
    }
    Ok(Response::new(packet::encode(
        &H {
            frame,
            timecode: info.tc(frame),
            width: w,
            height: h,
        },
        &rgba,
    )?))
}

/// En-tête d'une image composée renvoyée par l'interface.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComposedHeader {
    frame: u64,
    width: u32,
    height: u32,
    #[serde(default)]
    job: Option<u64>,
    #[serde(default)]
    shot: Option<u32>,
}

/// Écrit une image composée (overlay) par l'interface. Corps binaire :
/// paquet [en-tête JSON][RVBA]. Le nom et le dossier sont choisis ici.
#[tauri::command]
pub async fn write_composed(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<CaptureResult, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Binary body expected.".into());
    };
    let (h, _) = packet::decode::<ComposedHeader>(body)?;
    let info = state.video()?;
    let job = match h.job {
        Some(id) => Some(
            lock(&state.batch)?
                .clone()
                .filter(|j| j.id == id)
                .ok_or("This export was cancelled.")?,
        ),
        None => None,
    };
    let (settings, dir, info) = match &job {
        Some(j) => (j.settings.clone(), j.dir.clone(), j.info.clone()),
        None => {
            let s = state.settings()?;
            let d = PathBuf::from(
                s.output_dir
                    .clone()
                    .ok_or("Choose an output folder first.")?,
            );
            (s, d, info)
        }
    };
    if h.frame >= info.frame_count {
        return Err("Frame outside the film.".into());
    }
    let body = body.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (_, rgba) = packet::decode::<ComposedHeader>(&body)?;
        capture_from_rgba(
            &info, h.frame, h.shot, rgba, h.width, h.height, &settings, &dir,
        )
    })
    .await
    .map_err(|e| format!("Encoding task interrupted: {e}"))??;
    if let Some(j) = job {
        let palette = lock(&j.palettes)?.remove(&h.frame);
        let done = {
            let mut w = lock(&j.written)?;
            w.push(crate::jobs::Written {
                capture: res.clone(),
                palette,
            });
            w.len()
        };
        let _ = j.events.send(crate::jobs::JobEvent::Written {
            capture: res.clone(),
        });
        let _ = j.events.send(crate::jobs::JobEvent::Progress {
            phase: "export",
            done: done as u64,
            total: j.total as u64,
        });
    }
    Ok(res)
}

/// Montre un fichier dans l'Explorateur, uniquement dans le dossier de
/// sortie ou l'un de ses sous-dossiers d'export.
#[tauri::command]
pub fn reveal(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = inside_output(&state, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
}

/// Ouvre un dossier d'export dans l'Explorateur : le dossier de sortie
/// (`None`) ou l'un de ses sous-dossiers d'export.
#[tauri::command]
pub fn open_folder(state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    let out_dir = state
        .settings()?
        .output_dir
        .ok_or("Choose an output folder first.")?;
    let target = inside_output(&state, path.as_deref().unwrap_or(&out_dir))?;
    if !target.is_dir() {
        return Err("Folder not found.".into());
    }
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// Chemin réel de `path`, refusé s'il sort du dossier de sortie (2 niveaux au plus).
fn inside_output(state: &AppState, path: &str) -> Result<std::path::PathBuf, String> {
    let out_dir = state.settings()?.output_dir.ok_or("No output folder.")?;
    let base = std::fs::canonicalize(&out_dir)
        .map_err(|_| "The output folder no longer exists.".to_string())?;
    let target = std::fs::canonicalize(path).map_err(|_| "File not found.".to_string())?;
    if !target.starts_with(&base)
        || target
            .strip_prefix(&base)
            .map(|r| r.components().count())
            .unwrap_or(9)
            > 2
    {
        return Err("Path outside the output folder.".into());
    }
    Ok(target)
}

/// Écrit la palette de l'image `frame` pour d'autres logiciels :
/// .ase (Adobe, Affinity), .css, .gpl (GIMP, Krita), .json.
#[tauri::command]
pub async fn save_palette(
    app: AppHandle,
    state: State<'_, AppState>,
    frame: u64,
) -> Result<Vec<String>, String> {
    let info: VideoInfo = state.video()?;
    let settings = state.settings()?;
    let dir = PathBuf::from(
        settings
            .output_dir
            .clone()
            .ok_or("Choose an output folder first.")?,
    );
    let frame = frame.min(info.frame_count.saturating_sub(1));
    let raw = run_raw(
        tool(&app, "ffmpeg")?.args(capture_args(&info, frame)),
        "ffmpeg",
    )
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut px = raw;
        convert_in_place(&mut px, 3, settings.export.color);
        let sw = palette_of(&settings, &px, info.out_width, info.out_height, 3);
        if sw.is_empty() {
            return Err("No color found in this frame.".to_string());
        }
        let tc = info.tc(frame);
        let name = format!("{} {}", film_stem(&info.file_name), tc);
        let stem = format!(
            "{}_{}_palette",
            film_stem(&info.file_name),
            tc_for_file(&tc)
        );
        let files: [(&str, Vec<u8>); 4] = [
            ("ase", swatches::ase(&sw, &name)),
            ("css", swatches::css(&sw, &name).into_bytes()),
            ("gpl", swatches::gpl(&sw, &name).into_bytes()),
            (
                "json",
                swatches::json_doc(&sw, &name, &tc, frame).into_bytes(),
            ),
        ];
        let mut written = Vec::new();
        for (ext, data) in files {
            let path = unique_path(&dir, &format!("{stem}.{ext}"));
            photogramme_core::capture::write_new_file(&path, &data)?;
            written.push(path.to_string_lossy().to_string());
        }
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())?
}
