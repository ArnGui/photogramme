//! Ouverture d'un film : sélecteur natif ou glisser-déposer natif.
//!
//! L'interface n'envoie jamais de chemin : le glisser-déposer est capté par
//! la fenêtre côté Rust (`WindowEvent::DragDrop`), le sélecteur est ouvert en
//! Rust. Le résultat part vers l'interface par l'événement `film-opened`.

use crate::jobs::tool;
use crate::runner::run_raw;
use crate::state::{lock, AppState};
use photogramme_core::{parse_probe, probe_args, VideoInfo};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

/// Extensions acceptées à l'ouverture (films finis en H.264).
pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "mkv"];

pub async fn open_video_impl<R: Runtime>(app: &AppHandle<R>, state: &AppState, path: &str) -> Result<VideoInfo, String> {
    let p = Path::new(path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(".{ext} files are not supported (mp4, mov, m4v, mkv)."));
    }
    if !p.is_file() {
        return Err("File not found.".into());
    }
    let stdout = run_raw(tool(app, "ffprobe")?.args(probe_args(path)), "ffprobe").await?;
    let info = parse_probe(&String::from_utf8_lossy(&stdout), path)?;

    // La WebView ne peut lire que les fichiers explicitement autorisés
    // (scope vide dans tauri.conf.json) : on ouvre uniquement ce fichier-là.
    // Un film fermé reste lisible jusqu'à la fermeture de l'application :
    // l'API de Tauri ne sait pas retirer une autorisation sans l'interdire
    // pour toujours (on ne pourrait plus rouvrir ce film).
    app.asset_protocol_scope()
        .allow_file(p)
        .map_err(|e| format!("Read permission refused: {e}"))?;

    state.stop_jobs();
    *lock(&state.analysis)? = None;
    *lock(&state.cuts)? = None;
    *lock(&state.video)? = Some(info.clone());
    crate::project_cmd::remember_opened(state, &info.path);
    let mode = state.settings()?.export.timecode;
    Ok(info.with_tc_mode(mode))
}

/// Sélecteur de film ouvert côté Rust (aucun effet sur les scopes).
#[tauri::command]
pub async fn pick_video(app: AppHandle, state: State<'_, AppState>) -> Result<Option<VideoInfo>, String> {
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file().set_title("Open a film").add_filter("H.264 video", &VIDEO_EXTENSIONS);
        if let Some(w) = a.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked.and_then(|f| f.into_path().ok()) {
        Some(p) => open_video_impl(&app, &state, &p.to_string_lossy()).await.map(Some),
        None => Ok(None),
    }
}

/// Film ouvert, avec le timecode choisi dans les réglages (après un
/// changement de réglage, ou au rechargement de l'interface).
#[tauri::command]
pub fn current_video(state: State<'_, AppState>) -> Option<VideoInfo> {
    state.video().ok()
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilmEvent {
    Opened { info: Box<VideoInfo> },
    Failed { message: String },
}

/// Film passé en argument au lancement (« Ouvrir avec » sous Windows,
/// `open Photogramme.app --args film.mp4` sur Mac, tests de la CI) :
/// premier argument qui est un fichier vidéo existant. Les options
/// (`-psn_…` ajouté par d'anciens macOS) sont ignorées.
pub fn startup_film(args: impl IntoIterator<Item = String>) -> Option<PathBuf> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).find(|p| {
        p.extension()
            .map(|e| VIDEO_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
            .unwrap_or(false)
            && p.is_file()
    })
}

/// Ouvre le film passé au lancement, AVANT que l'interface ne se charge :
/// elle le trouve en demandant `current_video`, comme après un rechargement.
/// Même chemin que le sélecteur (sonde, scope asset fichier par fichier).
pub fn open_at_startup<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let path = path.to_string_lossy().to_string();
    if let Err(e) = tauri::async_runtime::block_on(open_video_impl(app, &state, &path)) {
        eprintln!("Photogramme: cannot open {path}: {e}");
    }
}

/// Fichiers déposés sur la fenêtre : ouverture du premier film reconnu.
pub fn on_drop<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) {
    let film = paths.iter().find(|p| {
        p.extension()
            .map(|e| VIDEO_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
            .unwrap_or(false)
    });
    let Some(path) = film.cloned() else {
        let _ = app.emit("film", FilmEvent::Failed { message: "This file is not a supported video.".into() });
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return };
        let ev = match open_video_impl(&app, &state, &path.to_string_lossy()).await {
            Ok(info) => FilmEvent::Opened { info: Box::new(info) },
            Err(message) => FilmEvent::Failed { message },
        };
        let _ = app.emit("film", ev);
    });
}
