//! Export d'une palette pour d'autres logiciels :
//! - `.ase` (Adobe Swatch Exchange : Photoshop, Illustrator, InDesign, Affinity) ;
//! - `.css` (variables CSS) ;
//! - `.gpl` (GIMP, Krita, Inkscape) ;
//! - `.json` (codes, parts, Lab).
//!
//! Format ASE : en-tête « ASEF », version 1.0, puis un bloc par couleur
//! (type 0x0001, nom en UTF-16 gros-boutiste, modèle « RGB », trois flottants
//! 32 bits gros-boutistes de 0 à 1, type 2 = couleur normale), le tout
//! encadré d'un groupe portant le nom de la palette.

use crate::palette::Swatch;
use serde_json::json;

fn utf16_name(name: &str) -> Vec<u8> {
    let units: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut v = (units.len() as u16).to_be_bytes().to_vec();
    for u in units {
        v.extend(u.to_be_bytes());
    }
    v
}

fn block(kind: u16, body: &[u8]) -> Vec<u8> {
    let mut v = kind.to_be_bytes().to_vec();
    v.extend((body.len() as u32).to_be_bytes());
    v.extend(body);
    v
}

/// Nom lisible d'une pastille : « 01 #C81E1E ».
fn swatch_name(i: usize, s: &Swatch) -> String {
    format!("{:02} {}", i + 1, s.hex)
}

pub fn ase(swatches: &[Swatch], palette_name: &str) -> Vec<u8> {
    let mut blocks = Vec::new();
    blocks.push(block(0xC001, &utf16_name(palette_name)));
    for (i, s) in swatches.iter().enumerate() {
        let mut body = utf16_name(&swatch_name(i, s));
        body.extend(b"RGB ");
        for c in s.rgb {
            body.extend((c as f32 / 255.0).to_be_bytes());
        }
        body.extend(2u16.to_be_bytes());
        blocks.push(block(0x0001, &body));
    }
    blocks.push(block(0xC002, &[]));

    let mut out = b"ASEF".to_vec();
    out.extend(1u16.to_be_bytes());
    out.extend(0u16.to_be_bytes());
    out.extend((blocks.len() as u32).to_be_bytes());
    for b in blocks {
        out.extend(b);
    }
    out
}

/// Identifiant CSS sûr à partir d'un nom de film.
fn css_ident(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() || s.starts_with(|c: char| c.is_ascii_digit()) { format!("p-{s}") } else { s }
}

pub fn css(swatches: &[Swatch], palette_name: &str) -> String {
    let id = css_ident(palette_name);
    let mut s = format!("/* {} : palette Photogramme */\n:root {{\n", palette_name.replace("*/", ""));
    for (i, sw) in swatches.iter().enumerate() {
        s.push_str(&format!("  --{id}-{:02}: {}; /* {:.0} % */\n", i + 1, sw.hex.to_lowercase(), sw.share * 100.0));
    }
    s.push_str("}\n");
    s
}

pub fn gpl(swatches: &[Swatch], palette_name: &str) -> String {
    let name: String = palette_name.chars().filter(|c| !c.is_control()).collect();
    let mut s = format!("GIMP Palette\nName: {name}\nColumns: {}\n#\n", swatches.len().max(1));
    for (i, sw) in swatches.iter().enumerate() {
        s.push_str(&format!("{:3} {:3} {:3}\t{}\n", sw.rgb[0], sw.rgb[1], sw.rgb[2], swatch_name(i, sw)));
    }
    s
}

pub fn json_doc(swatches: &[Swatch], palette_name: &str, timecode: &str, frame: u64) -> String {
    let v = json!({
        "name": palette_name,
        "timecode": timecode,
        "frame": frame,
        "colors": swatches.iter().map(|s| json!({
            "hex": s.hex,
            "rgb": s.rgb,
            "share": (s.share * 10_000.0).round() / 10_000.0,
            "lab": s.lab.map(|c| (c * 100.0).round() / 100.0),
        })).collect::<Vec<_>>(),
    });
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sw(hex: &str, rgb: [u8; 3], share: f32) -> Swatch {
        Swatch { hex: hex.into(), rgb, share, lab: [50.0, 10.0, -5.0] }
    }

    #[test]
    fn ase_bien_forme() {
        let p = vec![sw("#C81E1E", [200, 30, 30], 0.5), sw("#143CC8", [20, 60, 200], 0.5)];
        let a = ase(&p, "Film");
        assert_eq!(&a[0..4], b"ASEF");
        assert_eq!(u32::from_be_bytes(a[8..12].try_into().unwrap()), 4, "groupe + 2 couleurs + fin");
        // Parcours des blocs : chaque longueur doit tomber juste.
        let mut i = 12;
        let mut kinds = Vec::new();
        while i < a.len() {
            kinds.push(u16::from_be_bytes([a[i], a[i + 1]]));
            let len = u32::from_be_bytes(a[i + 2..i + 6].try_into().unwrap()) as usize;
            i += 6 + len;
        }
        assert_eq!(i, a.len());
        assert_eq!(kinds, vec![0xC001, 0x0001, 0x0001, 0xC002]);
        // Rouge de la première couleur = 200/255.
        let pos = a.windows(4).position(|w| w == b"RGB ").unwrap() + 4;
        let r = f32::from_be_bytes(a[pos..pos + 4].try_into().unwrap());
        assert!((r - 200.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn textes() {
        let p = vec![sw("#C81E1E", [200, 30, 30], 0.75)];
        let c = css(&p, "Le Film (v2) */");
        assert!(c.contains("--le-film-v2-01: #c81e1e;"), "{c}");
        assert_eq!(c.lines().next().unwrap().matches("*/").count(), 1, "le nom ne ferme jamais le commentaire");
        assert!(gpl(&p, "Film").contains("200  30  30\t01 #C81E1E"));
        let j: serde_json::Value = serde_json::from_str(&json_doc(&p, "Film", "01:00:00:00", 12)).unwrap();
        assert_eq!(j["colors"][0]["hex"], "#C81E1E");
        assert_eq!(css_ident("2049"), "p-2049");
    }
}
