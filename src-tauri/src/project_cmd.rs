//! Projets et onglets : le travail sur chaque film survit à la fermeture.
//!
//! Un seul film est chargé à la fois ; les onglets sont la liste des films
//! récents, et changer d'onglet recharge un film depuis son projet (analyse
//! comprise). Les chemins restent côté Rust : l'interface ne manipule que des
//! clés d'onglet, jamais un chemin qu'elle aurait fabriqué.

use crate::film::open_video_impl;
use crate::shots_cmd::{summary, AnalysisSummary};
use crate::state::{lock, AppState, StoredAnalysis};
use photogramme_core::analysis::Analysis;
use photogramme_core::cuts::ImportedCuts;
use photogramme_core::project::{
    self, analyses_size, decode_analysis, encode_analysis, film_key, prune_analyses, write_atomic,
    Fingerprint, LoadError, StoredCuts, MAX_ANALYSIS_BYTES, MAX_SESSION_BYTES,
};
use photogramme_core::VideoInfo;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

/// Nombre maximal d'onglets gardés ; au-delà, le plus ancien inactif disparaît.
pub const MAX_TABS: usize = 12;

/// Une seule écriture de projet à la fois (sessions écrites en rafale).
static IO: Mutex<()> = Mutex::new(());

fn io_lock() -> std::sync::MutexGuard<'static, ()> {
    IO.lock().unwrap_or_else(|e| e.into_inner())
}

/* ───────────── Onglets ───────────── */

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Tabs {
    pub active: Option<String>,
    pub tabs: Vec<TabEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabEntry {
    pub key: String,
    pub path: String,
}

impl Tabs {
    pub fn load(root: &Path) -> Self {
        fs::read(root.join("tabs.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Tabs>(&b).ok())
            .map(|mut t| {
                // Fichier abîmé ou modifié à la main : on garde ce qui est cohérent.
                t.tabs.retain(|e| e.key == film_key(&e.path));
                t.tabs.truncate(MAX_TABS);
                if t.active
                    .as_ref()
                    .is_some_and(|a| !t.tabs.iter().any(|e| &e.key == a))
                {
                    t.active = None;
                }
                t
            })
            .unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let _g = io_lock();
        write_atomic(&root.join("tabs.json"), &json)
            .map_err(|e| format!("Cannot save the tabs: {e}"))
    }

    /// Film ouvert : ajouté s'il n'a pas d'onglet, rendu actif.
    pub fn opened(&mut self, path: &str) {
        let key = film_key(path);
        match self.tabs.iter_mut().find(|e| e.key == key) {
            Some(e) => e.path = path.to_string(),
            None => self.tabs.push(TabEntry {
                key: key.clone(),
                path: path.to_string(),
            }),
        }
        while self.tabs.len() > MAX_TABS {
            let i = self.tabs.iter().position(|e| e.key != key).unwrap_or(0);
            self.tabs.remove(i);
        }
        self.active = Some(key);
    }

    /// Onglet fermé (le projet reste sur le disque).
    pub fn close(&mut self, key: &str) {
        self.tabs.retain(|e| e.key != key);
        if self.active.as_deref() == Some(key) {
            self.active = None;
        }
    }

    pub fn path_of(&self, key: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|e| e.key == key)
            .map(|e| e.path.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    key: String,
    file_name: String,
    folder: String,
    /// Le fichier n'est plus à cet endroit (déplacé, disque débranché).
    missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsView {
    active: Option<String>,
    tabs: Vec<TabView>,
}

impl From<&Tabs> for TabsView {
    fn from(t: &Tabs) -> Self {
        Self {
            active: t.active.clone(),
            tabs: t
                .tabs
                .iter()
                .map(|e| {
                    let p = Path::new(&e.path);
                    TabView {
                        key: e.key.clone(),
                        file_name: p
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        folder: p
                            .parent()
                            .map(|d| d.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        missing: !p.is_file(),
                    }
                })
                .collect(),
        }
    }
}

/// Appelé à chaque ouverture réussie d'un film.
pub fn remember_opened(state: &AppState, path: &str) {
    let Ok(_g) = state.tabs_lock.lock() else {
        return;
    };
    let mut t = Tabs::load(&state.projects_dir);
    t.opened(path);
    let _ = t.save(&state.projects_dir);
}

#[tauri::command]
pub fn tabs_list(state: State<'_, AppState>) -> TabsView {
    let _g = state.tabs_lock.lock();
    TabsView::from(&Tabs::load(&state.projects_dir))
}

/// Ouvre le film d'un onglet.
#[tauri::command]
pub async fn tab_open(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<VideoInfo, String> {
    let path = {
        let _g = lock(&state.tabs_lock)?;
        Tabs::load(&state.projects_dir)
            .path_of(&key)
            .ok_or("This tab no longer exists.")?
    };
    if !Path::new(&path).is_file() {
        return Err(format!(
            "The film is no longer at {path}. Reopen it from its new location with +."
        ));
    }
    open_video_impl(&app, &state, &path).await
}

/// Ferme un onglet. S'il s'agit du film chargé, il est déchargé.
#[tauri::command]
pub fn tab_close(state: State<'_, AppState>, key: String) -> Result<TabsView, String> {
    let t = {
        let _g = lock(&state.tabs_lock)?;
        let mut t = Tabs::load(&state.projects_dir);
        t.close(&key);
        t.save(&state.projects_dir)?;
        t
    };
    let loaded = lock(&state.video)?.as_ref().map(|v| film_key(&v.path));
    if loaded.as_deref() == Some(key.as_str()) {
        state.stop_jobs();
        *lock(&state.analysis)? = None;
        *lock(&state.cuts)? = None;
        *lock(&state.video)? = None;
    }
    Ok(TabsView::from(&t))
}

/* ───────────── Projet du film ouvert ───────────── */

/// Ce qui est enregistré dans `session.json`.
#[derive(Serialize, Deserialize)]
struct SessionFile {
    path: String,
    fingerprint: Fingerprint,
    ui: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    /// État de l'interface tel qu'elle l'a enregistré.
    ui: Option<serde_json::Value>,
    analysis: Option<AnalysisSummary>,
    imported: Option<ImportedCuts>,
    /// Le fichier a changé depuis la dernière fois : l'analyse a été écartée.
    film_changed: bool,
}

fn dir_of(state: &AppState, info: &VideoInfo) -> PathBuf {
    project::project_dir(&state.projects_dir, &info.path)
}

struct Loaded {
    ui: Option<serde_json::Value>,
    analysis: Option<Analysis>,
    cuts: Option<ImportedCuts>,
    changed: bool,
}

fn load_project(dir: &Path, film: &Path, frames: u64) -> Loaded {
    let mut out = Loaded {
        ui: None,
        analysis: None,
        cuts: None,
        changed: false,
    };
    let Ok(fp) = Fingerprint::of(film) else {
        return out;
    };
    if let Some(s) = fs::read(dir.join("session.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<SessionFile>(&b).ok())
    {
        out.changed |= s.fingerprint != fp;
        out.ui = Some(s.ui);
    }
    if let Some(c) = fs::read(dir.join("cuts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<StoredCuts>(&b).ok())
    {
        if c.fingerprint == fp {
            out.cuts = c.into_cuts(frames);
        } else {
            out.changed = true;
        }
    }
    let bin = dir.join("analysis.bin");
    if let Ok(bytes) = fs::read(&bin) {
        match decode_analysis(&bytes, &fp) {
            Ok(a) => {
                // Dernière utilisation : le ménage garde les analyses récentes.
                if let Ok(f) = fs::File::options().write(true).open(&bin) {
                    let _ = f.set_modified(std::time::SystemTime::now());
                }
                out.analysis = Some(a);
            }
            Err(LoadError::Stale) => {
                out.changed = true;
                let _ = fs::remove_file(&bin);
            }
            Err(LoadError::Invalid(_)) => {
                let _ = fs::remove_file(&bin);
            }
        }
    }
    out
}

/// Recharge le projet du film qui vient d'être ouvert : état de l'interface,
/// coupes importées, analyse (sans la relancer).
#[tauri::command]
pub async fn project_restore(state: State<'_, AppState>) -> Result<Restored, String> {
    let info = state.video()?;
    let dir = dir_of(&state, &info);
    let (film, frames) = (PathBuf::from(&info.path), info.frame_count);
    let loaded = tauri::async_runtime::spawn_blocking(move || load_project(&dir, &film, frames))
        .await
        .map_err(|e| e.to_string())?;
    if state.video()?.path != info.path {
        return Err("The film changed while its project was loading.".into());
    }
    let mut analysis = None;
    if let Some(data) = loaded.analysis {
        let mut slot = lock(&state.analysis)?;
        // Une analyse lancée entre-temps a priorité sur celle du disque.
        if slot.as_ref().is_none_or(|a| a.path != info.path) {
            let id = state.new_id();
            analysis = Some(summary(id, &data, None, 0.0));
            *slot = Some(Arc::new(StoredAnalysis {
                id,
                path: info.path.clone(),
                data,
            }));
        }
    }
    if let Some(c) = &loaded.cuts {
        let mut slot = lock(&state.cuts)?;
        if slot.is_none() {
            *slot = Some(Arc::new(c.clone()));
        }
    }
    Ok(Restored {
        ui: loaded.ui,
        analysis,
        imported: loaded.cuts,
        film_changed: loaded.changed,
    })
}

/// Enregistre l'état de l'interface pour le film ouvert (appelé en continu).
#[tauri::command]
pub async fn project_save(
    state: State<'_, AppState>,
    path: String,
    ui: serde_json::Value,
) -> Result<(), String> {
    let info = state.video()?;
    // L'état vient d'un film qui n'est plus ouvert (dépôt d'un autre film) :
    // l'écrire ici mélangerait deux projets.
    if info.path != path {
        return Ok(());
    }
    let dir = dir_of(&state, &info);
    tauri::async_runtime::spawn_blocking(move || {
        let fingerprint = Fingerprint::of(Path::new(&info.path))
            .map_err(|e| format!("Cannot read the film: {e}"))?;
        let json = serde_json::to_vec(&SessionFile {
            path: info.path,
            fingerprint,
            ui,
        })
        .map_err(|e| e.to_string())?;
        if json.len() > MAX_SESSION_BYTES {
            return Err("The project is too large to be saved.".into());
        }
        let _g = io_lock();
        write_atomic(&dir.join("session.json"), &json)
            .map_err(|e| format!("Cannot save the project: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Garde l'analyse sur le disque (en tâche de fond), puis fait le ménage.
pub fn save_analysis(state: &AppState, stored: Arc<StoredAnalysis>) {
    let root = state.projects_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let film = Path::new(&stored.path);
        let Ok(fp) = Fingerprint::of(film) else {
            return;
        };
        let bytes = encode_analysis(&stored.data, &fp);
        let bin = project::project_dir(&root, &stored.path).join("analysis.bin");
        let _g = io_lock();
        if write_atomic(&bin, &bytes).is_ok() {
            prune_analyses(&root, MAX_ANALYSIS_BYTES, Some(&bin));
        }
    });
}

/// Garde les coupes importées (ou les oublie, `None`).
pub fn save_cuts(state: &AppState, info: &VideoInfo, cuts: Option<&ImportedCuts>) {
    let file = dir_of(state, info).join("cuts.json");
    let _g = io_lock();
    match cuts {
        Some(c) => {
            if let Ok(fp) = Fingerprint::of(Path::new(&info.path)) {
                if let Ok(json) = serde_json::to_vec(&StoredCuts::new(c, fp)) {
                    let _ = write_atomic(&file, &json);
                }
            }
        }
        None => {
            let _ = fs::remove_file(file);
        }
    }
}

/// Place occupée par les analyses gardées, en octets.
#[tauri::command]
pub async fn project_cache_size(state: State<'_, AppState>) -> Result<u64, String> {
    let root = state.projects_dir.clone();
    tauri::async_runtime::spawn_blocking(move || analyses_size(&root))
        .await
        .map_err(|e| e.to_string())
}

/// Supprime les analyses gardées (les sessions et les onglets restent).
#[tauri::command]
pub async fn project_cache_clear(state: State<'_, AppState>) -> Result<u64, String> {
    let root = state.projects_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = io_lock();
        prune_analyses(&root, 0, None)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(p: &str) -> TabEntry {
        TabEntry {
            key: film_key(p),
            path: p.into(),
        }
    }

    #[test]
    fn opening_adds_once_and_activates() {
        let mut t = Tabs::default();
        t.opened("/f/a.mp4");
        t.opened("/f/b.mp4");
        t.opened("/f/a.mp4");
        assert_eq!(t.tabs, vec![entry("/f/a.mp4"), entry("/f/b.mp4")]);
        assert_eq!(t.active, Some(film_key("/f/a.mp4")));
    }

    #[test]
    fn too_many_tabs_drop_the_oldest_inactive() {
        let mut t = Tabs::default();
        for i in 0..=MAX_TABS {
            t.opened(&format!("/f/{i}.mp4"));
        }
        assert_eq!(t.tabs.len(), MAX_TABS);
        assert_eq!(t.tabs[0], entry("/f/1.mp4"));
        assert_eq!(t.active, Some(film_key(&format!("/f/{MAX_TABS}.mp4"))));
    }

    #[test]
    fn closing_keeps_the_rest() {
        let mut t = Tabs::default();
        t.opened("/f/a.mp4");
        t.opened("/f/b.mp4");
        t.close(&film_key("/f/b.mp4"));
        assert_eq!(t.tabs, vec![entry("/f/a.mp4")]);
        assert_eq!(t.active, None);
        t.close("nope");
        assert_eq!(t.tabs.len(), 1);
    }

    #[test]
    fn tabs_file_round_trip_and_tampering() {
        let d = std::env::temp_dir().join(format!("photogramme-tabs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let mut t = Tabs::default();
        t.opened("/f/a.mp4");
        t.save(&d).unwrap();
        assert_eq!(Tabs::load(&d), t);
        // Une clé qui ne correspond pas à son chemin est écartée, l'onglet actif aussi.
        let forged = r#"{"active":"x","tabs":[{"key":"x","path":"/etc/passwd"}]}"#;
        fs::write(d.join("tabs.json"), forged).unwrap();
        assert_eq!(Tabs::load(&d), Tabs::default());
        fs::write(d.join("tabs.json"), "not json").unwrap();
        assert_eq!(Tabs::load(&d), Tabs::default());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn project_files_come_back_and_stale_analysis_is_dropped() {
        let d = std::env::temp_dir().join(format!("photogramme-proj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let film = d.join("film.mp4");
        fs::write(&film, b"0123456789").unwrap();
        let fp = Fingerprint::of(&film).unwrap();
        let dir = d.join("p");
        let mut thumbs = std::collections::BTreeMap::new();
        thumbs.insert(0u64, vec![0xFF, 0xD8]);
        let a = Analysis {
            frames: 2,
            scores: vec![0.0, 50.0],
            columns: vec![1; 2 * 3],
            geometry: photogramme_core::analysis::Geometry {
                analysis_w: 2,
                analysis_h: 2,
                thumb_w: 2,
                thumb_h: 1,
            },
            thumbs,
            decoder: photogramme_core::analysis::Decoder::Cpu,
        };
        write_atomic(&dir.join("analysis.bin"), &encode_analysis(&a, &fp)).unwrap();
        let session = SessionFile {
            path: film.to_string_lossy().into(),
            fingerprint: fp,
            ui: serde_json::json!({"v": 1, "frame": 1}),
        };
        write_atomic(
            &dir.join("session.json"),
            &serde_json::to_vec(&session).unwrap(),
        )
        .unwrap();

        let l = load_project(&dir, &film, 2);
        assert!(l.analysis.is_some() && !l.changed);
        assert_eq!(l.ui, Some(serde_json::json!({"v": 1, "frame": 1})));

        // Le film est réécrit : l'analyse est écartée et supprimée, la session reste.
        fs::write(&film, b"another film, longer").unwrap();
        let l = load_project(&dir, &film, 2);
        assert!(l.analysis.is_none() && l.changed && l.ui.is_some());
        assert!(!dir.join("analysis.bin").exists());
        fs::remove_dir_all(&d).unwrap();
    }
}
