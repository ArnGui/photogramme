//! Gestion des couleurs à l'export : profil ICC et conversion de gamma.
//!
//! Un master Rec.709 est étalonné pour un écran BT.1886 (gamma 2,4). Un JPEG
//! sans profil est lu par tous les logiciels comme du sRGB (≈ gamma 2,2) :
//! l'image paraît un peu plus claire et moins contrastée que dans Resolve.
//! Trois choix :
//! - `Untagged` : pixels tels quels, sans profil (comportement historique) ;
//! - `Rec709` : pixels tels quels + profil « Rec.709 / BT.1886 γ2,4 » : un
//!   logiciel qui gère les couleurs (Photoshop, Lightroom, Affinity) affiche
//!   l'image comme le moniteur d'étalonnage ;
//! - `Srgb` : pixels convertis de γ2,4 vers la courbe sRGB, profil sRGB
//!   intégré : même rendu partout, y compris sur le web et les réseaux.
//!
//! La conversion `Srgb` préserve la luminance affichée (BT.1886 → sRGB, même
//! primaires BT.709/sRGB, même blanc D65). Elle ne cherche pas à compenser
//! la différence d'ambiance de visionnage (salle sombre / bureau éclairé).
//! Sources : ITU-R BT.1886 (2011), IEC 61966-2-1 (sRGB), ICC.1:2001-04 (v2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColorProfile {
    #[default]
    Untagged,
    Rec709,
    Srgb,
}

impl ColorProfile {
    /// Les pixels doivent-ils être convertis avant composition et encodage ?
    pub fn converts(self) -> bool {
        self == ColorProfile::Srgb
    }
}

fn srgb_oetf(l: f64) -> f64 {
    if l <= 0.003_130_8 { 12.92 * l } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

fn srgb_eotf(v: f64) -> f64 {
    if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// Table de conversion 8 bits : code BT.1886 (γ2,4) → code sRGB, même luminance.
pub fn bt1886_to_srgb_lut() -> [u8; 256] {
    let mut t = [0u8; 256];
    for (i, v) in t.iter_mut().enumerate() {
        let l = (i as f64 / 255.0).powf(2.4);
        *v = (srgb_oetf(l) * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    t
}

/// Convertit sur place une image RVB (`bpp` = 3) ou RVBA (`bpp` = 4).
/// L'alpha n'est pas touché.
pub fn convert_in_place(px: &mut [u8], bpp: usize, profile: ColorProfile) {
    if !profile.converts() || bpp < 3 {
        return;
    }
    let lut = bt1886_to_srgb_lut();
    for p in px.chunks_exact_mut(bpp) {
        p[0] = lut[p[0] as usize];
        p[1] = lut[p[1] as usize];
        p[2] = lut[p[2] as usize];
    }
}

/// Même conversion pour une couleur seule (pastilles de palette).
pub fn convert_rgb(rgb: [u8; 3], profile: ColorProfile) -> [u8; 3] {
    if !profile.converts() {
        return rgb;
    }
    let lut = bt1886_to_srgb_lut();
    rgb.map(|c| lut[c as usize])
}

/* ───────────── Profils ICC v2 (matrice + courbes) ───────────── */

/// Profil ICC à intégrer au fichier, `None` pour une image non taguée.
pub fn icc_profile(profile: ColorProfile) -> Option<Vec<u8>> {
    match profile {
        ColorProfile::Untagged => None,
        ColorProfile::Rec709 => Some(build_icc("Rec.709 BT.1886 (gamma 2.4) - Photogramme", Trc::Gamma(2.4))),
        ColorProfile::Srgb => Some(build_icc("sRGB IEC61966-2.1 - Photogramme", Trc::Srgb)),
    }
}

enum Trc {
    Gamma(f64),
    Srgb,
}

fn s15f16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

fn xyz_tag(x: f64, y: f64, z: f64) -> Vec<u8> {
    let mut t = b"XYZ \0\0\0\0".to_vec();
    t.extend(s15f16(x));
    t.extend(s15f16(y));
    t.extend(s15f16(z));
    t
}

fn curv_tag(trc: &Trc) -> Vec<u8> {
    let mut t = b"curv\0\0\0\0".to_vec();
    match trc {
        Trc::Gamma(g) => {
            t.extend(1u32.to_be_bytes());
            // u8Fixed8 : 2,4 → 614/256 = 2,398.
            t.extend(((g * 256.0).round() as u16).to_be_bytes());
        }
        Trc::Srgb => {
            const N: u32 = 1024;
            t.extend(N.to_be_bytes());
            for i in 0..N {
                let v = srgb_eotf(i as f64 / (N - 1) as f64);
                t.extend(((v * 65535.0).round() as u16).to_be_bytes());
            }
        }
    }
    t
}

fn desc_tag(text: &str) -> Vec<u8> {
    let ascii: Vec<u8> = text.bytes().filter(|b| b.is_ascii() && *b >= 0x20).collect();
    let mut t = b"desc\0\0\0\0".to_vec();
    t.extend(((ascii.len() + 1) as u32).to_be_bytes());
    t.extend(&ascii);
    t.push(0);
    t.extend([0u8; 4]); // langue Unicode
    t.extend([0u8; 4]); // 0 caractère Unicode
    t.extend([0u8; 2]); // code de script
    t.push(0); // 0 caractère ScriptCode
    t.extend([0u8; 67]);
    t
}

fn text_tag(text: &str) -> Vec<u8> {
    let mut t = b"text\0\0\0\0".to_vec();
    t.extend(text.bytes().filter(|b| b.is_ascii()));
    t.push(0);
    t
}

// `% 4 != 0` plutôt que `is_multiple_of` : ce dernier exige Rust 1.87.
#[allow(clippy::manual_is_multiple_of)]
fn build_icc(description: &str, trc: Trc) -> Vec<u8> {
    // Primaires BT.709 = sRGB, adaptées D65 → D50 (Bradford), blanc D50 :
    // les valeurs du profil sRGB de référence.
    let curve = curv_tag(&trc);
    let tags: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"desc", desc_tag(description)),
        (*b"cprt", text_tag("No copyright, use freely")),
        (*b"wtpt", xyz_tag(0.9642, 1.0, 0.8249)),
        (*b"rXYZ", xyz_tag(0.436_074_7, 0.222_504_5, 0.013_932_2)),
        (*b"gXYZ", xyz_tag(0.385_064_9, 0.716_878_6, 0.097_104_5)),
        (*b"bXYZ", xyz_tag(0.143_080_4, 0.060_616_9, 0.714_173_3)),
        (*b"rTRC", curve.clone()),
        (*b"gTRC", curve.clone()),
        (*b"bTRC", curve),
    ];

    let table_len = 4 + 12 * tags.len();
    let mut data: Vec<u8> = Vec::new();
    let mut entries: Vec<([u8; 4], u32, u32)> = Vec::new();
    let mut shared: Option<(u32, u32)> = None;
    for (sig, body) in &tags {
        // Les trois courbes identiques partagent les mêmes octets.
        if matches!(sig, b"gTRC" | b"bTRC") {
            if let Some((o, l)) = shared {
                entries.push((*sig, o, l));
                continue;
            }
        }
        while data.len() % 4 != 0 {
            data.push(0);
        }
        let offset = (128 + table_len + data.len()) as u32;
        entries.push((*sig, offset, body.len() as u32));
        if sig == b"rTRC" {
            shared = Some((offset, body.len() as u32));
        }
        data.extend(body);
    }
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let size = (128 + table_len + data.len()) as u32;

    let mut p = Vec::with_capacity(size as usize);
    p.extend(size.to_be_bytes());
    p.extend([0u8; 4]); // CMM préféré : aucun
    p.extend([0x02, 0x10, 0x00, 0x00]); // version 2.1
    p.extend(b"mntr");
    p.extend(b"RGB ");
    p.extend(b"XYZ ");
    // Date fixe (2026-01-01) : même fichier à chaque export.
    for v in [2026u16, 1, 1, 0, 0, 0] {
        p.extend(v.to_be_bytes());
    }
    p.extend(b"acsp");
    p.extend(b"MSFT");
    p.extend([0u8; 4]); // drapeaux
    p.extend([0u8; 4]); // fabricant
    p.extend([0u8; 4]); // modèle
    p.extend([0u8; 8]); // attributs
    p.extend(0u32.to_be_bytes()); // intention : perceptuelle
    p.extend(s15f16(0.9642));
    p.extend(s15f16(1.0));
    p.extend(s15f16(0.8249));
    p.extend([0u8; 4]); // créateur
    p.extend([0u8; 16]); // identifiant (v4 seulement)
    p.extend([0u8; 28]);
    debug_assert_eq!(p.len(), 128);
    p.extend((tags.len() as u32).to_be_bytes());
    for (sig, o, l) in entries {
        p.extend(sig);
        p.extend(o.to_be_bytes());
        p.extend(l.to_be_bytes());
    }
    p.extend(data);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_conversion_garde_le_noir_et_le_blanc_et_assombrit_les_tons_moyens() {
        let lut = bt1886_to_srgb_lut();
        assert_eq!((lut[0], lut[255]), (0, 255));
        // γ2,4 → sRGB : affiché tel quel en sRGB, un gris moyen paraîtrait trop
        // clair ; son code baisse pour garder la même luminance (128 → 121).
        assert_eq!(lut[128], 121);
        assert!(lut.windows(2).all(|w| w[0] <= w[1]), "monotone");
        let mut px = vec![128u8, 64, 32, 7, 128, 64, 32, 255];
        convert_in_place(&mut px, 4, ColorProfile::Srgb);
        assert_eq!(px[3], 7, "alpha intact");
        assert_eq!(px[0], lut[128]);
        let mut same = vec![1u8, 2, 3];
        convert_in_place(&mut same, 3, ColorProfile::Rec709);
        assert_eq!(same, vec![1, 2, 3], "Rec.709 : pixels tels quels");
    }

    #[test]
    #[allow(clippy::manual_is_multiple_of)]
    fn profils_icc_bien_formes() {
        assert!(icc_profile(ColorProfile::Untagged).is_none());
        for p in [ColorProfile::Rec709, ColorProfile::Srgb] {
            let icc = icc_profile(p).unwrap();
            let size = u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize;
            assert_eq!(size, icc.len());
            assert_eq!(&icc[36..40], b"acsp");
            assert_eq!(size % 4, 0);
            let n = u32::from_be_bytes(icc[128..132].try_into().unwrap()) as usize;
            assert_eq!(n, 9);
            for k in 0..n {
                let e = 132 + 12 * k;
                let off = u32::from_be_bytes(icc[e + 4..e + 8].try_into().unwrap()) as usize;
                let len = u32::from_be_bytes(icc[e + 8..e + 12].try_into().unwrap()) as usize;
                assert!(off % 4 == 0 && off + len <= icc.len());
            }
        }
    }
}
