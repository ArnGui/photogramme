//! Couche Tauri : orchestration uniquement.
//! Toute la logique testable vit dans le crate `photogramme-core`.
//!
//! Sécurité :
//! - l'interface n'a aucune permission shell ni système de fichiers ;
//! - les sélecteurs de fichier/dossier sont ouverts ICI, en Rust. L'API Rust
//!   du plugin dialog ne touche à aucun scope, alors que la commande JS
//!   `open` ouvre le scope asset RÉCURSIVEMENT sur un dossier choisi
//!   (tauri-plugin-dialog 2.8.1, commands.rs) ;
//! - le glisser-déposer est capté par la fenêtre en Rust : l'interface
//!   n'envoie jamais de chemin de fichier ;
//! - le scope asset est ouvert fichier par fichier, ou dossier par dossier
//!   sans récursivité, uniquement pour ce que l'application a produit ;
//! - l'interface n'envoie jamais de chemin d'écriture : elle fournit des
//!   pixels et un numéro d'image, le Rust choisit le fichier ;
//! - les liens externes (dépôt, Ko-fi) sont fixés en Rust ;
//! - les mises à jour sont vérifiées par signature (minisign), liée à la
//!   version annoncée (`requireSignedVersion` : pas de retour en arrière forcé).

mod app_cmd;
mod batch_cmd;
mod film;
mod frames;
mod jobs;
mod project_cmd;
mod runner;
mod shots_cmd;
mod state;

use photogramme_core::settings;
use state::AppState;
use std::path::Path;
use tauri::{DragDropEvent, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let pubkey = app_cmd::updater_pubkey(context.config());
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Sans clé publique (build local), pas de plugin : rien ne pourrait être vérifié.
    if pubkey.is_some() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        // Vignettes des plans servies depuis la mémoire, sans fichier temporaire.
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, req, responder| {
            let analysis = ctx
                .app_handle()
                .try_state::<AppState>()
                .and_then(|s| s.analysis.lock().ok().and_then(|a| a.clone()));
            responder.respond(shots_cmd::thumb_response(analysis, req.uri().path()));
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                film::on_drop(window.app_handle(), paths);
            }
            if let WindowEvent::Destroyed = event {
                // Aucun FFmpeg orphelin à la fermeture.
                if let Some(s) = window.app_handle().try_state::<AppState>() {
                    s.stop_jobs();
                }
            }
        })
        .setup(move |app| {
            let config = app.path().app_config_dir()?;
            let projects = app.path().app_local_data_dir()?.join("projects");
            let settings_path = config.join("settings.json");
            let loaded = settings::load(&settings_path);
            if let Some(dir) = loaded.output_dir.as_deref().filter(|d| Path::new(d).is_dir()) {
                let _ = app.asset_protocol_scope().allow_directory(dir, false);
            }
            app.manage(AppState::new(loaded, settings_path, config.join("presets"), projects, pubkey.is_some()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            film::pick_video,
            film::current_video,
            frames::capture,
            frames::grab_frame,
            frames::grab_probe,
            frames::write_composed,
            frames::reveal,
            frames::open_folder,
            frames::save_palette,
            shots_cmd::analyze,
            shots_cmd::cancel_analysis,
            shots_cmd::list_shots,
            shots_cmd::import_cuts,
            shots_cmd::clear_cuts,
            shots_cmd::barcode_preview,
            shots_cmd::export_barcode,
            batch_cmd::batch_plan,
            batch_cmd::batch_start,
            batch_cmd::batch_pull,
            batch_cmd::sheet_page,
            batch_cmd::batch_finish,
            batch_cmd::batch_cancel,
            app_cmd::get_settings,
            app_cmd::update_settings,
            app_cmd::pick_output_dir,
            app_cmd::list_presets,
            app_cmd::save_preset,
            app_cmd::delete_preset,
            app_cmd::open_presets_folder,
            app_cmd::app_info,
            app_cmd::open_link,
            app_cmd::check_update,
            app_cmd::install_update,
            project_cmd::tabs_list,
            project_cmd::tab_open,
            project_cmd::tab_close,
            project_cmd::project_restore,
            project_cmd::project_save,
            project_cmd::project_cache_size,
            project_cmd::project_cache_clear,
        ])
        .run(context)
        .expect("error while starting Photogramme");
}

#[cfg(test)]
mod tests;
