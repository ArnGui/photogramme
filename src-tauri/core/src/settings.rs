//! Réglages persistants (JSON lisible et modifiable à la main).
//!
//! Rétrocompatibles : un `settings.json` du sprint 1 (qualité, chroma,
//! dossier) se charge tel quel, les nouvelles sections prennent leurs
//! valeurs par défaut.

use crate::analysis::THRESHOLD_FLOOR;
use crate::barcode::BarcodeMode;
use crate::color::ColorProfile;
use crate::jpeg::{Chroma, ImageFormat};
use crate::overlay::{OverlayPreset, ScopeKind};
use crate::palette::PaletteOptions;
use crate::pick::Pick;
use crate::probe::TimecodeMode;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Décodeur souhaité pour l'analyse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DecoderPref {
    /// GPU si le fichier s'y prête, sinon processeur ; repli automatique.
    #[default]
    Auto,
    Gpu,
    Cpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BatchMode {
    #[default]
    Shots,
    Interval,
    Spread,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportSettings {
    /// Export en lot dans un sous-dossier « film_plans », « film_intervalle »…
    pub subfolder: bool,
    /// Appliquer l'overlay (palette, textes) aux images exportées.
    pub overlay: bool,
    /// Écrire la liste des images exportées en CSV (séparateur « ; », pour Excel).
    pub csv: bool,
    /// Ajouter au CSV la palette de chaque image (codes hexadécimaux).
    pub csv_palette: bool,
    /// JPEG ou PNG.
    pub format: ImageFormat,
    /// Profil ICC / conversion de gamma (voir `color.rs`).
    pub color: ColorProfile,
    /// Timecode du fichier ou depuis 00:00:00:00.
    pub timecode: TimecodeMode,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            subfolder: true,
            overlay: false,
            csv: true,
            csv_palette: false,
            format: ImageFormat::Jpeg,
            color: ColorProfile::Untagged,
            timecode: TimecodeMode::File,
        }
    }
}

/// Format de page d'une planche contact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SheetPage {
    #[default]
    A4,
    A3,
    Letter,
    Tabloid,
    /// Une seule grande image, sans pagination.
    Image,
}

impl SheetPage {
    /// Taille en millimètres (portrait), `None` pour une image libre.
    pub fn millimeters(self) -> Option<(f64, f64)> {
        match self {
            SheetPage::A4 => Some((210.0, 297.0)),
            SheetPage::A3 => Some((297.0, 420.0)),
            SheetPage::Letter => Some((215.9, 279.4)),
            SheetPage::Tabloid => Some((279.4, 431.8)),
            SheetPage::Image => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SheetFormat {
    #[default]
    Pdf,
    Jpeg,
    Png,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SheetTheme {
    #[default]
    Dark,
    Light,
}

/// Planche contact : grille de photogrammes légendés.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetSettings {
    pub columns: u32,
    pub page: SheetPage,
    pub landscape: bool,
    pub format: SheetFormat,
    /// Résolution des pages (PDF, JPEG, PNG), en points par pouce.
    pub dpi: u32,
    /// Largeur d'une image libre (`SheetPage::Image`), en pixels.
    pub image_width: u32,
    pub theme: SheetTheme,
    /// Titre en tête de page (jetons {film} {date} {count}).
    pub title: String,
    pub show_tc: bool,
    pub show_shot: bool,
    pub show_clip: bool,
    pub show_frame: bool,
    pub show_palette: bool,
}

impl Default for SheetSettings {
    fn default() -> Self {
        Self {
            columns: 4,
            page: SheetPage::A4,
            landscape: true,
            format: SheetFormat::Pdf,
            dpi: 200,
            image_width: 3840,
            theme: SheetTheme::Dark,
            title: "{film}".into(),
            show_tc: true,
            show_shot: true,
            show_clip: true,
            show_frame: false,
            show_palette: false,
        }
    }
}

impl SheetSettings {
    /// Taille d'une page en millimètres (paysage appliqué), `None` pour une image libre.
    pub fn page_mm_landscaped(&self) -> Option<(f64, f64)> {
        let (w, h) = self.page.millimeters()?;
        Some(if self.landscape { (h, w) } else { (w, h) })
    }

    /// Taille d'une page en pixels (paysage appliqué), ou `None` pour une image libre.
    pub fn page_pixels(&self) -> Option<(u32, u32)> {
        let (w, h) = self.page_mm_landscaped()?;
        let px = |mm: f64| (mm / 25.4 * self.dpi as f64).round() as u32;
        Some((px(w), px(h)))
    }
}

/// Mises à jour automatiques.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    /// Vérifier au démarrage (une requête vers GitHub, rien d'autre n'est envoyé).
    pub check_at_startup: bool,
    /// Version que l'utilisateur a choisi d'ignorer.
    pub skipped: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { check_at_startup: true, skipped: None }
    }
}

/// Préférences d'affichage mémorisées entre deux sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    pub scopes_open: bool,
    pub scope: ScopeKind,
    /// Bande au-dessus de la timeline : code-barre, vignettes du film ou rien.
    pub strip: StripMode,
    /// Thème de l'interface.
    pub theme: Theme,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self { scopes_open: false, scope: ScopeKind::Waveform, strip: StripMode::Barcode, theme: Theme::Dark }
    }
}

/// Thème de l'interface (les écrans d'image restent sombres dans les deux).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

/// Contenu de la bande au-dessus de la timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StripMode {
    #[default]
    Barcode,
    Frames,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShotSettings {
    /// Seuil `scdet`, de 3 à 60. 10 = valeur par défaut de FFmpeg.
    pub threshold: f32,
    /// Durée minimale d'un plan, en secondes.
    pub min_seconds: f32,
    pub pick: Pick,
    pub decoder: DecoderPref,
}

impl Default for ShotSettings {
    fn default() -> Self {
        Self { threshold: 10.0, min_seconds: 0.5, pick: Pick::Middle, decoder: DecoderPref::Auto }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BatchSettings {
    pub mode: BatchMode,
    pub interval_seconds: f64,
    pub spread_count: u32,
}

impl Default for BatchSettings {
    fn default() -> Self {
        Self { mode: BatchMode::Shots, interval_seconds: 10.0, spread_count: 24 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BarcodeSettings {
    pub width: u32,
    pub height: u32,
    pub mode: BarcodeMode,
}

impl Default for BarcodeSettings {
    fn default() -> Self {
        Self { width: 3840, height: 1080, mode: BarcodeMode::Vertical }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Qualité JPEG, 1–100. Défaut 92 : au-delà de ~95 le poids explose
    /// pour un gain rarement visible.
    pub quality: u8,
    pub chroma: Chroma,
    /// Dossier de sortie ; `None` = demander à la première capture.
    pub output_dir: Option<String>,
    pub export: ExportSettings,
    pub shots: ShotSettings,
    pub batch: BatchSettings,
    pub palette: PaletteOptions,
    pub barcode: BarcodeSettings,
    /// Overlay en cours d'édition (copie de travail d'un préréglage).
    pub overlay: OverlayPreset,
    pub sheet: SheetSettings,
    pub updates: UpdateSettings,
    pub ui: UiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            quality: 92,
            chroma: Chroma::C444,
            output_dir: None,
            export: ExportSettings::default(),
            shots: ShotSettings::default(),
            batch: BatchSettings::default(),
            palette: PaletteOptions::default(),
            barcode: BarcodeSettings::default(),
            overlay: OverlayPreset::default(),
            sheet: SheetSettings::default(),
            updates: UpdateSettings::default(),
            ui: UiSettings::default(),
        }
    }
}

fn finite_or(v: f64, d: f64) -> f64 {
    if v.is_finite() { v } else { d }
}

impl Settings {
    /// Ramène les valeurs dans des bornes valides (fichier édité à la main).
    pub fn sanitized(mut self) -> Self {
        self.quality = self.quality.clamp(1, 100);
        if matches!(self.output_dir.as_deref(), Some(d) if d.trim().is_empty()) {
            self.output_dir = None;
        }
        let s = &mut self.shots;
        s.threshold = finite_or(s.threshold as f64, 10.0).clamp(THRESHOLD_FLOOR as f64, 60.0) as f32;
        s.min_seconds = finite_or(s.min_seconds as f64, 0.5).clamp(0.0, 30.0) as f32;
        if let Pick::Spread { count } = &mut s.pick {
            *count = (*count).clamp(1, 100);
        }
        let b = &mut self.batch;
        b.interval_seconds = finite_or(b.interval_seconds, 10.0).clamp(0.04, 3600.0);
        b.spread_count = b.spread_count.clamp(1, 10_000);
        self.palette = self.palette.sanitized();
        self.barcode.width = self.barcode.width.clamp(16, 16_384);
        self.barcode.height = self.barcode.height.clamp(4, 16_384);
        self.overlay = self.overlay.sanitized();
        let sh = &mut self.sheet;
        sh.columns = sh.columns.clamp(1, 12);
        sh.dpi = sh.dpi.clamp(72, 600);
        sh.image_width = sh.image_width.clamp(640, 16_000);
        sh.title = sh.title.chars().filter(|c| !c.is_control()).take(200).collect();
        if let Some(v) = &mut self.updates.skipped {
            v.retain(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
            v.truncate(40);
        }
        self
    }

    /// Durée minimale de plan en images, pour une cadence donnée.
    pub fn min_shot_frames(&self, fps: f64) -> u64 {
        ((self.shots.min_seconds as f64) * fps).round().max(1.0) as u64
    }
}

/// Charge les réglages ; fichier absent ou corrompu → valeurs par défaut.
pub fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Écrit les réglages via un fichier temporaire, pour ne jamais laisser
/// un JSON à moitié écrit en cas de coupure.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Settings folder: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, json).map_err(|e| format!("Cannot write settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot write settings: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("photogramme-settings-{}-{name}", std::process::id()))
            .join(name)
    }

    #[test]
    fn aller_retour() {
        let p = tmp("a.json");
        let mut s = Settings { quality: 85, chroma: Chroma::C420, output_dir: Some(r"D:\Captures".into()), ..Default::default() };
        s.shots.pick = Pick::Spread { count: 3 };
        s.palette.count = 8;
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn fichier_absent_ou_corrompu() {
        assert_eq!(load(&tmp("absent.json")), Settings::default());
        let p = tmp("bad.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{ pas du json").unwrap();
        assert_eq!(load(&p), Settings::default());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn complete_les_champs_manquants_et_borne() {
        let s: Settings = serde_json::from_str(r#"{"quality": 0}"#).unwrap();
        let s = s.sanitized();
        assert_eq!(s.quality, 1);
        assert_eq!(s.chroma, Chroma::C444);
    }

    #[test]
    fn charge_un_fichier_du_sprint_1() {
        let p = tmp("v1.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"quality": 88, "chroma": "4:2:0", "outputDir": "D:\\Captures"}"#).unwrap();
        let s = load(&p);
        assert_eq!((s.quality, s.chroma, s.output_dir.as_deref()), (88, Chroma::C420, Some(r"D:\Captures")));
        assert_eq!(s.shots, ShotSettings::default());
        assert_eq!(s.overlay.name, "Cinema");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn bornes_des_nouvelles_sections() {
        let s: Settings = serde_json::from_str(
            r#"{"shots":{"threshold":0.5,"minSeconds":-3,"pick":{"mode":"spread","count":0}},
                "batch":{"intervalSeconds":0,"spreadCount":0},
                "palette":{"count":99},"barcode":{"width":1,"height":99999}}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.shots.threshold, THRESHOLD_FLOOR);
        assert_eq!(s.shots.min_seconds, 0.0);
        assert_eq!(s.shots.pick, Pick::Spread { count: 1 });
        assert_eq!(s.batch.interval_seconds, 0.04);
        assert_eq!(s.batch.spread_count, 1);
        assert_eq!(s.palette.count, 16);
        assert_eq!((s.barcode.width, s.barcode.height), (16, 16_384));
        assert_eq!(s.min_shot_frames(24.0), 1);
    }

    #[test]
    fn planche_contact_et_nouvelles_options() {
        let s: Settings = serde_json::from_str(
            r#"{"sheet":{"columns":40,"dpi":5,"page":"a3","landscape":false},
                "export":{"format":"png","color":"srgb","timecode":"zero"},
                "updates":{"skipped":"0.5.0<script>"}}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!((s.sheet.columns, s.sheet.dpi), (12, 72));
        assert_eq!(s.export.format, ImageFormat::Png);
        assert_eq!(s.export.color, ColorProfile::Srgb);
        assert_eq!(s.export.timecode, TimecodeMode::Zero);
        assert_eq!(s.updates.skipped.as_deref(), Some("0.5.0script"));
        assert!(s.updates.check_at_startup);
        // A4 paysage à 200 dpi.
        let a4 = SheetSettings::default().page_pixels().unwrap();
        assert_eq!(a4, (2339, 1654));
        assert_eq!(SheetSettings { page: SheetPage::Image, ..Default::default() }.page_pixels(), None);
    }
}
