//! Réglages, préréglages d'overlay, informations sur l'application,
//! liens externes et mises à jour.

use crate::state::{lock, AppState};
use photogramme_core::overlay::{self, OverlayPreset};
use photogramme_core::{settings, Settings};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

/// Dépôt public du projet.
pub const REPO_URL: &str = "https://github.com/ArnGui/photogramme";
/// Identifiant Ko-fi pour le bouton « Buy me a coffee » (vide = bouton masqué).
/// Seul endroit à modifier : https://ko-fi.com/<identifiant>.
pub const KOFI_HANDLE: &str = "";

/* ─────────────── Réglages ─────────────── */

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state.settings()
}

pub fn apply_settings<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    new: Settings,
) -> Result<Settings, String> {
    let new = new.sanitized();
    if let Some(dir) = &new.output_dir {
        let d = Path::new(dir);
        if !d.is_dir() {
            return Err("This output folder does not exist.".into());
        }
        // Vignettes des captures : ce dossier seulement, sans ses sous-dossiers.
        app.asset_protocol_scope()
            .allow_directory(d, false)
            .map_err(|e| format!("Folder permission refused: {e}"))?;
    }
    settings::save(&state.settings_path, &new)?;
    *lock(&state.settings)? = new.clone();
    Ok(new)
}

/// Met à jour et enregistre les réglages.
/// Le dossier de sortie n'est PAS modifiable par cette voie : seul le
/// sélecteur Rust (`pick_output_dir`) le change. Sinon l'interface pourrait
/// désigner n'importe quel dossier existant, qui deviendrait lisible par
/// le protocole asset.
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut new: Settings,
) -> Result<Settings, String> {
    new.output_dir = state.settings()?.output_dir;
    apply_settings(&app, &state, new)
}

/// Sélecteur du dossier de sortie, côté Rust.
#[tauri::command]
pub async fn pick_output_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Settings>, String> {
    let a = app.clone();
    let current = state.settings()?.output_dir;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file().set_title("Output folder");
        // Le sélecteur s'ouvre sur le dossier actuel, pas sur le dernier dossier vu par Windows.
        if let Some(cur) = current.filter(|c| Path::new(c).is_dir()) {
            d = d.set_directory(cur);
        }
        if let Some(w) = a.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(dir) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let mut s = state.settings()?;
    s.output_dir = Some(dir.to_string_lossy().to_string());
    apply_settings(&app, &state, s).map(Some)
}

/* ─────────────── Préréglages d'overlay ─────────────── */

#[tauri::command]
pub fn list_presets(state: State<'_, AppState>) -> Vec<OverlayPreset> {
    overlay::list_presets(&state.presets_dir)
}

#[tauri::command]
pub fn save_preset(
    state: State<'_, AppState>,
    preset: OverlayPreset,
) -> Result<Vec<OverlayPreset>, String> {
    overlay::save_preset(&state.presets_dir, &preset)?;
    Ok(overlay::list_presets(&state.presets_dir))
}

#[tauri::command]
pub fn delete_preset(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<OverlayPreset>, String> {
    overlay::delete_preset(&state.presets_dir, &name)?;
    Ok(overlay::list_presets(&state.presets_dir))
}

/// Ouvre le dossier des préréglages dans l'Explorateur (pour copier/sauvegarder les JSON).
#[tauri::command]
pub fn open_presets_folder(state: State<'_, AppState>) -> Result<(), String> {
    std::fs::create_dir_all(&state.presets_dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&state.presets_dir, None::<&str>).map_err(|e| e.to_string())
}

/* ─────────────── Application et liens ─────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    repo: String,
    kofi: Option<String>,
    updates_enabled: bool,
}

pub fn kofi_url() -> Option<String> {
    let h = KOFI_HANDLE.trim();
    let valid = !h.is_empty()
        && h.len() <= 64
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then(|| format!("https://ko-fi.com/{h}"))
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        repo: REPO_URL.into(),
        kofi: kofi_url(),
        updates_enabled: state.updates_enabled,
    }
}

/// Liens ouverts dans le navigateur. Les adresses sont fixées ici :
/// l'interface ne peut pas faire ouvrir une adresse de son choix.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Link {
    Repo,
    Releases,
    Issues,
    Kofi,
}

pub fn link_url(link: Link) -> Option<String> {
    match link {
        Link::Repo => Some(REPO_URL.into()),
        Link::Releases => Some(format!("{REPO_URL}/releases")),
        Link::Issues => Some(format!("{REPO_URL}/issues")),
        Link::Kofi => kofi_url(),
    }
}

#[tauri::command]
pub fn open_link(link: Link) -> Result<(), String> {
    let url = link_url(link).ok_or("This link is not set up in this build.")?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/* ─────────────── Mises à jour ─────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    /// Version disponible, `None` si l'application est à jour.
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

/// Interroge GitHub (latest.json de la dernière release). Aucune donnée
/// n'est envoyée en dehors de la requête elle-même.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    if !state.updates_enabled {
        return Err("Automatic updates are not set up in this build.".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;
    let info = UpdateInfo {
        current,
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        date: found
            .as_ref()
            .and_then(|u| u.date.map(|d| d.date().to_string())),
    };
    *lock(&state.pending_update)? = found;
    Ok(info)
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Installing,
}

/// Télécharge la mise à jour trouvée, vérifie sa signature, l'installe et
/// relance l'application. Sous Windows, l'installeur ferme l'application
/// puis la relance lui-même.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<UpdateEvent>,
) -> Result<(), String> {
    let update = lock(&state.pending_update)?
        .take()
        .ok_or("Check for updates first.")?;
    // Plus aucun FFmpeg ne doit tourner quand l'installeur remplace les fichiers.
    state.stop_jobs();
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_event.send(UpdateEvent::Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    let _ = on_event.send(UpdateEvent::Installing);
    update
        .install(bytes)
        .map_err(|e| format!("Installation failed: {e}"))?;
    app.restart();
}

/// Clé publique de mise à jour présente dans la configuration compilée ?
pub fn updater_pubkey(config: &tauri::Config) -> Option<String> {
    let key = config
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()?
        .trim()
        .to_string();
    (!key.is_empty()).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liens_fixes() {
        assert_eq!(link_url(Link::Repo).as_deref(), Some(REPO_URL));
        assert!(link_url(Link::Releases).unwrap().ends_with("/releases"));
        // Ko-fi : masqué tant que l'identifiant n'est pas renseigné, et jamais une adresse arbitraire.
        if KOFI_HANDLE.is_empty() {
            assert_eq!(link_url(Link::Kofi), None);
        } else {
            assert!(link_url(Link::Kofi)
                .unwrap()
                .starts_with("https://ko-fi.com/"));
        }
    }

    #[test]
    fn cle_de_mise_a_jour() {
        let mut c: tauri::Config = serde_json::from_str(r#"{"identifier":"a.b"}"#).unwrap();
        assert_eq!(updater_pubkey(&c), None);
        c.plugins
            .0
            .insert("updater".into(), serde_json::json!({"pubkey": "  "}));
        assert_eq!(
            updater_pubkey(&c),
            None,
            "clé vide : mises à jour désactivées"
        );
        c.plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": "dW50cnVzdGVk"}),
        );
        assert_eq!(updater_pubkey(&c).as_deref(), Some("dW50cnVzdGVk"));
    }
}
