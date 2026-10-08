//! État de l'application et travaux en cours.

use crate::jobs::{JobEvent, RawFrame, Written};
use crate::runner::ProcessGroup;
use photogramme_core::analysis::Analysis;
use photogramme_core::cuts::ImportedCuts;
use photogramme_core::sheet::JpegPage;
use photogramme_core::{Settings, VideoInfo};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::async_runtime::Receiver;
use tauri::ipc::Channel;

/// Analyse conservée pour le film ouvert.
pub struct StoredAnalysis {
    pub id: u64,
    pub path: String,
    pub data: Analysis,
}

/// Ce que produit un export en lot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    /// Un fichier par image.
    Stills,
    /// Une planche contact (pages composées par l'interface).
    Sheet,
}

/// Export en lot en cours.
pub struct BatchJob {
    pub id: u64,
    pub kind: JobKind,
    pub dir: PathBuf,
    pub info: VideoInfo,
    pub settings: Settings,
    pub total: usize,
    /// Taille des images décodées (taille d'export, ou case de planche contact).
    pub width: u32,
    pub height: u32,
    pub group: ProcessGroup,
    /// Mode composition : images décodées en attente d'être tirées par l'interface.
    pub frames: tauri::async_runtime::Mutex<Option<Receiver<RawFrame>>>,
    pub producer_error: Arc<Mutex<Option<String>>>,
    pub written: Mutex<Vec<Written>>,
    /// Palettes calculées au moment du tirage (CSV), par image.
    pub palettes: Mutex<HashMap<u64, Vec<String>>>,
    pub spans: HashMap<u32, (u64, u64)>,
    /// Liste de montage importée au lancement (noms de clips).
    pub cuts: Option<Arc<ImportedCuts>>,
    pub events: Channel<JobEvent>,
    /// Planche contact en PDF : pages encodées, assemblées à la fin.
    pub pages: Mutex<Vec<JpegPage>>,
    /// Planche contact en JPEG/PNG : fichiers déjà écrits.
    pub page_files: Mutex<Vec<String>>,
}

pub struct AppState {
    /// Film tel que sondé (timecode du fichier).
    pub video: Mutex<Option<VideoInfo>>,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub presets_dir: PathBuf,
    /// Projets par film et onglets (`projects/`).
    pub projects_dir: PathBuf,
    /// Lecture-écriture des onglets, une à la fois.
    pub tabs_lock: Mutex<()>,
    pub analysis: Mutex<Option<Arc<StoredAnalysis>>>,
    pub analysis_group: Mutex<Option<ProcessGroup>>,
    pub batch: Mutex<Option<Arc<BatchJob>>>,
    /// Coupes importées d'une liste de montage, pour le film ouvert.
    pub cuts: Mutex<Option<Arc<ImportedCuts>>>,
    pub next_id: AtomicU64,
    /// Mise à jour trouvée par la dernière vérification.
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Le binaire a été compilé avec une clé publique de mise à jour.
    pub updates_enabled: bool,
}

pub fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    m.lock().map_err(|_| "Internal state locked.".to_string())
}

impl AppState {
    pub fn new(settings: Settings, settings_path: PathBuf, presets_dir: PathBuf, projects_dir: PathBuf, updates_enabled: bool) -> Self {
        Self {
            video: Mutex::new(None),
            settings: Mutex::new(settings),
            settings_path,
            presets_dir,
            projects_dir,
            tabs_lock: Mutex::new(()),
            analysis: Mutex::new(None),
            analysis_group: Mutex::new(None),
            batch: Mutex::new(None),
            cuts: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending_update: Mutex::new(None),
            updates_enabled,
        }
    }

    /// Film ouvert, avec le timecode choisi dans les réglages.
    pub fn video(&self) -> Result<VideoInfo, String> {
        let mode = lock(&self.settings)?.export.timecode;
        lock(&self.video)?.clone().map(|v| v.with_tc_mode(mode)).ok_or_else(|| "No film open.".into())
    }

    pub fn settings(&self) -> Result<Settings, String> {
        Ok(lock(&self.settings)?.clone())
    }

    pub fn analysis(&self) -> Result<Arc<StoredAnalysis>, String> {
        lock(&self.analysis)?.clone().ok_or_else(|| "Analyze the film first.".into())
    }

    /// Analyse du film ouvert, s'il y en a une.
    pub fn analysis_for(&self, path: &str) -> Option<Arc<StoredAnalysis>> {
        lock(&self.analysis).ok()?.clone().filter(|a| a.path == path)
    }

    pub fn cuts(&self) -> Option<Arc<ImportedCuts>> {
        lock(&self.cuts).ok()?.clone()
    }

    pub fn new_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Arrête tout travail en cours (changement de film, fermeture).
    pub fn stop_jobs(&self) {
        if let Ok(mut g) = self.analysis_group.lock() {
            if let Some(g) = g.take() {
                g.cancel();
            }
        }
        if let Ok(mut b) = self.batch.lock() {
            if let Some(b) = b.take() {
                b.group.cancel();
            }
        }
    }
}
