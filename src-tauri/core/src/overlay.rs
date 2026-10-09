//! Préréglages d'overlay : schéma, validation et stockage en JSON.
//!
//! Le DESSIN se fait dans l'interface (Canvas), pour que l'aperçu et
//! l'export sortent de la même fonction. Le Rust ne fait que garantir que
//! tout préréglage chargé est sain : bornes numériques, couleurs valides,
//! textes limités, noms de police sans caractères dangereux.
//!
//! Unités : les tailles sont en « px base 1920 » : la valeur vaut des pixels
//! sur une image de 1920 px de large et suit la résolution du film
//! (×2 en UHD). Un préréglage rend donc pareil en HD et en 4K.

use crate::naming::sanitize_stem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_TEXTS: usize = 12;
const MAX_TEMPLATE: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    #[default]
    BottomLeft,
    Bottom,
    BottomRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Region {
    /// Positionné par rapport à l'image du film.
    #[default]
    Image,
    /// Positionné par rapport à toute la composition (marges comprises).
    Canvas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    /// Bande sous l'image.
    #[default]
    Below,
    /// Par-dessus le bas de l'image.
    Inside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SwatchStyle {
    /// Carrés de taille fixe.
    #[default]
    Squares,
    /// Rectangles qui remplissent toute la largeur.
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Font {
    pub family: String,
    pub size: f32,
    pub weight: u16,
    pub italic: bool,
}

impl Default for Font {
    fn default() -> Self {
        Self {
            family: "Barlow Condensed".into(),
            size: 28.0,
            weight: 500,
            italic: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FrameBox {
    pub pad_top: f32,
    pub pad_right: f32,
    pub pad_bottom: f32,
    pub pad_left: f32,
    pub background: String,
}

impl Default for FrameBox {
    fn default() -> Self {
        Self {
            pad_top: 0.0,
            pad_right: 0.0,
            pad_bottom: 0.0,
            pad_left: 0.0,
            background: "#000000".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaletteBand {
    pub enabled: bool,
    pub placement: Placement,
    pub style: SwatchStyle,
    /// Côté des carrés (ou hauteur des rectangles), px base 1920.
    pub size: f32,
    pub gap: f32,
    /// Espace entre l'image et la bande (ou le bord de l'image si « inside »).
    pub margin: f32,
    pub align: Align,
    pub show_hex: bool,
    pub hex_font: Font,
    pub hex_color: String,
}

impl Default for PaletteBand {
    fn default() -> Self {
        Self {
            enabled: true,
            placement: Placement::Below,
            style: SwatchStyle::Squares,
            size: 96.0,
            gap: 12.0,
            margin: 24.0,
            align: Align::Left,
            show_hex: false,
            hex_font: Font {
                family: "IBM Plex Mono".into(),
                size: 16.0,
                weight: 400,
                italic: false,
            },
            hex_color: "#A39E94".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextItem {
    pub id: String,
    pub enabled: bool,
    /// Texte libre avec jetons : {film} {tc} {frame} {shot} {clip} {date} {fps} {res}.
    pub template: String,
    pub font: Font,
    pub color: String,
    pub opacity: f32,
    pub uppercase: bool,
    /// Espacement des lettres, px base 1920.
    pub letter_spacing: f32,
    pub anchor: Anchor,
    pub region: Region,
    pub offset_x: f32,
    pub offset_y: f32,
    pub shadow: bool,
    pub box_enabled: bool,
    pub box_color: String,
    pub box_opacity: f32,
    pub box_padding: f32,
}

impl Default for TextItem {
    fn default() -> Self {
        Self {
            id: "text".into(),
            enabled: true,
            template: "{tc}".into(),
            font: Font::default(),
            color: "#FFFFFF".into(),
            opacity: 1.0,
            uppercase: false,
            letter_spacing: 0.0,
            anchor: Anchor::BottomRight,
            region: Region::Image,
            offset_x: 32.0,
            offset_y: 32.0,
            shadow: true,
            box_enabled: false,
            box_color: "#000000".into(),
            box_opacity: 0.5,
            box_padding: 8.0,
        }
    }
}

/// Instrument de mesure dessiné sur l'image (et dans la visionneuse).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    /// Forme d'onde de la luminance (Y' BT.709).
    #[default]
    Waveform,
    /// Formes d'onde R, V, B côte à côte.
    Parade,
    /// Chrominance Cb/Cr, cibles 75 % et ligne des tons chair.
    Vectorscope,
    /// Histogramme R, V, B.
    Histogram,
}

/// Scope incrusté dans l'image exportée.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScopeInset {
    pub enabled: bool,
    pub kind: ScopeKind,
    pub anchor: Anchor,
    pub region: Region,
    /// Largeur, px base 1920.
    pub size: f32,
    /// Opacité du fond du scope.
    pub opacity: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

impl Default for ScopeInset {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: ScopeKind::Waveform,
            anchor: Anchor::TopRight,
            region: Region::Image,
            size: 420.0,
            opacity: 0.75,
            offset_x: 32.0,
            offset_y: 32.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayPreset {
    pub name: String,
    pub frame: FrameBox,
    pub palette: PaletteBand,
    pub texts: Vec<TextItem>,
    pub scope: ScopeInset,
}

impl Default for OverlayPreset {
    fn default() -> Self {
        builtin_presets().remove(0)
    }
}

/// Couleur #RGB, #RRGGBB ou #RRGGBBAA, sinon la valeur de repli.
fn color(s: &str, fallback: &str) -> String {
    let t = s.trim();
    let ok = t.starts_with('#')
        && matches!(t.len(), 4 | 7 | 9)
        && t[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        t.to_uppercase()
    } else {
        fallback.into()
    }
}

fn num(v: f32, lo: f32, hi: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        fallback
    }
}

/// Nom de police utilisable dans `ctx.font` : pas de guillemets, points-virgules
/// ni accolades (ils casseraient la déclaration CSS).
fn family(s: &str) -> String {
    let f: String = s
        .chars()
        .filter(|c| {
            !matches!(c, '"' | '\'' | ';' | '{' | '}' | '\\' | '<' | '>') && !c.is_control()
        })
        .take(64)
        .collect();
    let f = f.trim().to_string();
    if f.is_empty() {
        "Barlow".into()
    } else {
        f
    }
}

fn clean_text(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect()
}

impl Font {
    fn sanitized(mut self) -> Self {
        self.family = family(&self.family);
        self.size = num(self.size, 4.0, 400.0, 28.0);
        self.weight = (self.weight.clamp(100, 900) / 100) * 100;
        self
    }
}

impl OverlayPreset {
    pub fn sanitized(mut self) -> Self {
        self.name = clean_text(self.name.trim(), 60);
        if self.name.is_empty() {
            self.name = "Untitled".into();
        }
        let f = &mut self.frame;
        for p in [
            &mut f.pad_top,
            &mut f.pad_right,
            &mut f.pad_bottom,
            &mut f.pad_left,
        ] {
            *p = num(*p, 0.0, 2000.0, 0.0);
        }
        f.background = color(&f.background, "#000000");

        let p = &mut self.palette;
        p.size = num(p.size, 4.0, 1000.0, 96.0);
        p.gap = num(p.gap, 0.0, 400.0, 12.0);
        p.margin = num(p.margin, 0.0, 1000.0, 24.0);
        p.hex_font = std::mem::take(&mut p.hex_font).sanitized();
        p.hex_color = color(&p.hex_color, "#A39E94");

        let sc = &mut self.scope;
        sc.size = num(sc.size, 80.0, 1920.0, 420.0);
        sc.opacity = num(sc.opacity, 0.0, 1.0, 0.75);
        sc.offset_x = num(sc.offset_x, -4000.0, 4000.0, 32.0);
        sc.offset_y = num(sc.offset_y, -4000.0, 4000.0, 32.0);

        self.texts.truncate(MAX_TEXTS);
        for (i, t) in self.texts.iter_mut().enumerate() {
            t.id = clean_text(&t.id, 40);
            if t.id.is_empty() {
                t.id = format!("text-{}", i + 1);
            }
            t.template = clean_text(&t.template, MAX_TEMPLATE);
            t.font = std::mem::take(&mut t.font).sanitized();
            t.color = color(&t.color, "#FFFFFF");
            t.opacity = num(t.opacity, 0.0, 1.0, 1.0);
            t.letter_spacing = num(t.letter_spacing, -20.0, 200.0, 0.0);
            t.offset_x = num(t.offset_x, -4000.0, 4000.0, 0.0);
            t.offset_y = num(t.offset_y, -4000.0, 4000.0, 0.0);
            t.box_color = color(&t.box_color, "#000000");
            t.box_opacity = num(t.box_opacity, 0.0, 1.0, 0.5);
            t.box_padding = num(t.box_padding, 0.0, 200.0, 8.0);
        }
        self
    }
}

fn text(
    id: &str,
    template: &str,
    family: &str,
    size: f32,
    weight: u16,
    anchor: Anchor,
    region: Region,
) -> TextItem {
    TextItem {
        id: id.into(),
        template: template.into(),
        font: Font {
            family: family.into(),
            size,
            weight,
            italic: false,
        },
        anchor,
        region,
        ..Default::default()
    }
}

/// Préréglages fournis, recopiés dans le dossier au premier lancement.
pub fn builtin_presets() -> Vec<OverlayPreset> {
    let cinema = OverlayPreset {
        name: "Cinema".into(),
        frame: FrameBox {
            pad_top: 48.0,
            pad_right: 48.0,
            pad_bottom: 40.0,
            pad_left: 48.0,
            background: "#0B0B0C".into(),
        },
        palette: PaletteBand::default(),
        texts: vec![
            TextItem {
                color: "#E9E4DA".into(),
                uppercase: true,
                letter_spacing: 6.0,
                shadow: false,
                // Dans la bande, au-dessus du timecode.
                offset_x: 48.0,
                offset_y: 84.0,
                ..text(
                    "film",
                    "{film}",
                    "Barlow Condensed",
                    30.0,
                    600,
                    Anchor::BottomRight,
                    Region::Canvas,
                )
            },
            TextItem {
                color: "#E0A43B".into(),
                shadow: false,
                offset_x: 48.0,
                offset_y: 40.0,
                ..text(
                    "tc",
                    "{tc}",
                    "IBM Plex Mono",
                    26.0,
                    500,
                    Anchor::BottomRight,
                    Region::Canvas,
                )
            },
        ],
        scope: ScopeInset::default(),
    };
    let minimal = OverlayPreset {
        name: "Minimal".into(),
        frame: FrameBox::default(),
        palette: PaletteBand {
            enabled: false,
            ..Default::default()
        },
        texts: vec![text(
            "tc",
            "{tc}",
            "IBM Plex Mono",
            28.0,
            500,
            Anchor::BottomRight,
            Region::Image,
        )],
        scope: ScopeInset::default(),
    };
    let fiche = OverlayPreset {
        name: "Color sheet".into(),
        frame: FrameBox {
            pad_top: 32.0,
            pad_right: 32.0,
            pad_bottom: 32.0,
            pad_left: 32.0,
            background: "#F2EFE9".into(),
        },
        palette: PaletteBand {
            style: SwatchStyle::Fill,
            size: 120.0,
            gap: 0.0,
            margin: 0.0,
            show_hex: true,
            hex_color: "#3A3A3D".into(),
            ..Default::default()
        },
        texts: vec![TextItem {
            color: "#141210".into(),
            shadow: false,
            box_enabled: false,
            offset_x: 32.0,
            offset_y: 8.0,
            ..text(
                "caption",
                "{film} — {tc}",
                "Barlow",
                22.0,
                400,
                Anchor::TopLeft,
                Region::Canvas,
            )
        }],
        scope: ScopeInset::default(),
    };
    // Planche de contrôle : image, forme d'onde incrustée, timecode.
    let qc = OverlayPreset {
        name: "Grading check".into(),
        frame: FrameBox::default(),
        palette: PaletteBand {
            enabled: false,
            ..Default::default()
        },
        texts: vec![TextItem {
            box_enabled: true,
            box_opacity: 0.6,
            shadow: false,
            ..text(
                "tc",
                "{tc}  ·  {clip}",
                "IBM Plex Mono",
                22.0,
                500,
                Anchor::BottomLeft,
                Region::Image,
            )
        }],
        scope: ScopeInset {
            enabled: true,
            kind: ScopeKind::Parade,
            ..Default::default()
        },
    };
    vec![cinema, minimal, fiche, qc]
}

/// Fichier d'un préréglage : nom nettoyé, jamais de chemin.
pub fn preset_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{}.json", sanitize_stem(name)))
}

/// Liste les préréglages ; dossier vide ou absent → recopie des préréglages fournis.
pub fn list_presets(dir: &Path) -> Vec<OverlayPreset> {
    let read = || -> Vec<OverlayPreset> {
        let mut v: Vec<OverlayPreset> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("json"))
            })
            .filter(|p| {
                std::fs::metadata(p)
                    .map(|m| m.len() < 256 * 1024)
                    .unwrap_or(false)
            })
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .filter_map(|s| serde_json::from_str::<OverlayPreset>(&s).ok())
            .map(OverlayPreset::sanitized)
            .collect();
        v.sort_by_key(|p| p.name.to_lowercase());
        v
    };
    let found = read();
    if !found.is_empty() {
        // Préréglages ajoutés par une mise à jour : recopiés une seule fois
        // (un préréglage supprimé ensuite par l'utilisateur ne revient pas).
        let marker = dir.join(".builtins-0.4");
        if !marker.exists() {
            for p in builtin_presets()
                .into_iter()
                .filter(|p| p.name == "Grading check")
            {
                if !found.iter().any(|f| f.name == p.name) {
                    let _ = save_preset(dir, &p);
                }
            }
            let _ = std::fs::write(&marker, b"");
            return read();
        }
        return found;
    }
    for p in builtin_presets() {
        let _ = save_preset(dir, &p);
    }
    let _ = std::fs::write(dir.join(".builtins-0.4"), b"");
    let v = read();
    if v.is_empty() {
        builtin_presets()
    } else {
        v
    }
}

pub fn save_preset(dir: &Path, preset: &OverlayPreset) -> Result<OverlayPreset, String> {
    let preset = preset.clone().sanitized();
    std::fs::create_dir_all(dir).map_err(|e| format!("Presets folder: {e}"))?;
    let path = preset_path(dir, &preset.name);
    let json = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, json).map_err(|e| format!("Cannot write preset: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot write preset: {e}"))?;
    Ok(preset)
}

pub fn delete_preset(dir: &Path, name: &str) -> Result<(), String> {
    let path = preset_path(dir, name);
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("Cannot delete: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("photogramme-presets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn nettoie_un_preset_hostile() {
        let json = r##"{
            "name": "",
            "frame": {"padTop": -5, "background": "red; x"},
            "palette": {"size": 1e9, "hexFont": {"family": "Arial\";}<script>", "weight": 950}},
            "texts": [{"template": "{tc}\u0007", "color": "#abc", "opacity": 7, "offsetX": "oops"}]
        }"##;
        // "oops" n'est pas un nombre : serde refuse, ce qui protège aussi.
        assert!(serde_json::from_str::<OverlayPreset>(json).is_err());
        let json = json.replace("\"oops\"", "12");
        let p = serde_json::from_str::<OverlayPreset>(&json)
            .unwrap()
            .sanitized();
        assert_eq!(p.name, "Untitled");
        assert_eq!(p.frame.pad_top, 0.0);
        assert_eq!(p.frame.background, "#000000");
        assert_eq!(p.palette.size, 1000.0);
        assert_eq!(p.palette.hex_font.family, "Arialscript");
        assert_eq!(p.palette.hex_font.weight, 900);
        assert_eq!(p.texts[0].template, "{tc}");
        assert_eq!(p.texts[0].color, "#ABC");
        assert_eq!(p.texts[0].opacity, 1.0);
        assert_eq!(p.texts[0].id, "text");
    }

    #[test]
    fn champs_manquants_completes() {
        let p: OverlayPreset = serde_json::from_str(r#"{"name":"X","texts":[{}]}"#).unwrap();
        assert_eq!(p.texts[0].template, "{tc}");
        assert!(p.palette.enabled);
        let names: Vec<_> = builtin_presets().into_iter().map(|p| p.name).collect();
        assert_eq!(
            names,
            vec!["Cinema", "Minimal", "Color sheet", "Grading check"]
        );
        assert!(!p.scope.enabled, "préréglage ancien : pas de scope");
    }

    #[test]
    fn mise_a_jour_ajoute_le_nouveau_preset_une_fois() {
        let dir = tmpdir("upgrade");
        std::fs::create_dir_all(&dir).unwrap();
        // Dossier d'une version 0.2 : trois préréglages, pas de marqueur.
        for p in builtin_presets().into_iter().take(3) {
            save_preset(&dir, &p).unwrap();
        }
        assert_eq!(list_presets(&dir).len(), 4);
        delete_preset(&dir, "Grading check").unwrap();
        assert_eq!(
            list_presets(&dir).len(),
            3,
            "supprimé par l'utilisateur : ne revient pas"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stockage_des_presets() {
        let dir = tmpdir("store");
        let first = list_presets(&dir);
        assert_eq!(first.len(), 4, "recopie des préréglages fournis");
        let mut p = first[0].clone();
        p.name = "../../My preset".into();
        save_preset(&dir, &p).unwrap();
        assert!(
            dir.join("My_preset.json").is_file(),
            "nom nettoyé, jamais de chemin"
        );
        assert_eq!(list_presets(&dir).len(), 5);
        delete_preset(&dir, "../../My preset").unwrap();
        assert_eq!(list_presets(&dir).len(), 4);
        // Fichier corrompu ignoré.
        std::fs::write(dir.join("broken.json"), "{").unwrap();
        assert_eq!(list_presets(&dir).len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
