//! Code-barre couleur du film : une colonne par tranche de temps.
//!
//! Construit à partir des colonnes calculées pendant l'analyse GPU (moyenne
//! de chaque ligne de chaque image) : aucun décodage supplémentaire.
//! Les moyennes se font en lumière linéaire, pas sur les valeurs sRGB :
//! une moyenne sRGB assombrit les mélanges (rouge + vert donnerait un brun
//! terne au lieu d'un jaune).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BarcodeMode {
    /// Garde la structure verticale (ciel en haut, sol en bas).
    #[default]
    Vertical,
    /// Une couleur unie par colonne.
    Average,
}

fn to_linear(c: u8) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn to_srgb(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let v = if c <= 0.003_130_8 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (v * 255.0).round() as u8
}

/// Image RVB `out_w`×`out_h` du code-barre.
/// `columns` : `frames` colonnes de `col_h` pixels RVB chacune.
pub fn render(
    columns: &[u8],
    col_h: usize,
    frames: u64,
    out_w: u32,
    out_h: u32,
    mode: BarcodeMode,
) -> Result<Vec<u8>, String> {
    let (ow, oh) = (out_w as usize, out_h as usize);
    if ow == 0 || oh == 0 || ow > 16_384 || oh > 16_384 {
        return Err("Invalid barcode size (1 to 16,384 px).".into());
    }
    let col_len = col_h * 3;
    if frames == 0 || col_h == 0 || columns.len() < frames as usize * col_len {
        return Err("Incomplete analysis: run the film analysis again.".into());
    }
    let lut: Vec<f32> = (0..=255u8).map(to_linear).collect();
    let n = frames as usize;
    let mut out = vec![0u8; ow * oh * 3];
    let mut acc = vec![0f32; col_len];

    for x in 0..ow {
        // Tranche [f0, f1) : au moins une image, même si le film est court.
        let f0 = (x * n / ow).min(n - 1);
        let f1 = ((x + 1) * n / ow).clamp(f0 + 1, n);
        acc.iter_mut().for_each(|a| *a = 0.0);
        for f in f0..f1 {
            for (a, &v) in acc.iter_mut().zip(&columns[f * col_len..(f + 1) * col_len]) {
                *a += lut[v as usize];
            }
        }
        let k = (f1 - f0) as f32;
        match mode {
            BarcodeMode::Average => {
                let mut c = [0f32; 3];
                for row in acc.chunks_exact(3) {
                    for i in 0..3 {
                        c[i] += row[i];
                    }
                }
                let px = c.map(|v| to_srgb(v / (k * col_h as f32)));
                for y in 0..oh {
                    out[(y * ow + x) * 3..(y * ow + x) * 3 + 3].copy_from_slice(&px);
                }
            }
            BarcodeMode::Vertical => {
                for y in 0..oh {
                    // Interpolation linéaire entre les lignes de la colonne.
                    let pos = ((y as f32 + 0.5) * col_h as f32 / oh as f32 - 0.5).clamp(0.0, (col_h - 1) as f32);
                    let r0 = pos.floor() as usize;
                    let r1 = (r0 + 1).min(col_h - 1);
                    let t = pos - r0 as f32;
                    for i in 0..3 {
                        let v = acc[r0 * 3 + i] * (1.0 - t) + acc[r1 * 3 + i] * t;
                        out[(y * ow + x) * 3 + i] = to_srgb(v / k);
                    }
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_colonne_par_tranche() {
        // 4 images, colonnes de 2 px : rouge, rouge, bleu, bleu (ligne haute) / noir (ligne basse).
        let mut cols = Vec::new();
        for c in [[255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255]] {
            cols.extend_from_slice(&c);
            cols.extend_from_slice(&[0, 0, 0]);
        }
        let img = render(&cols, 2, 4, 2, 2, BarcodeMode::Vertical).unwrap();
        assert_eq!(&img[0..3], &[255, 0, 0], "haut gauche");
        assert_eq!(&img[3..6], &[0, 0, 255], "haut droite");
        assert_eq!(&img[6..9], &[0, 0, 0], "bas gauche");

        let avg = render(&cols, 2, 4, 1, 1, BarcodeMode::Average).unwrap();
        // Moyenne linéaire de rouge, bleu et deux noirs : 0,25 → 137 en sRGB.
        assert_eq!(avg, vec![137, 0, 137]);
    }

    #[test]
    fn film_plus_court_que_la_largeur() {
        let cols = vec![10u8, 20, 30];
        let img = render(&cols, 1, 1, 5, 3, BarcodeMode::Vertical).unwrap();
        assert!(img.chunks(3).all(|p| p == [10, 20, 30]));
    }

    #[test]
    fn refuse_les_entrees_invalides() {
        assert!(render(&[0; 3], 1, 2, 10, 10, BarcodeMode::Average).is_err());
        assert!(render(&[0; 3], 1, 1, 0, 10, BarcodeMode::Average).is_err());
        assert!(render(&[0; 3], 1, 1, 20_000, 10, BarcodeMode::Average).is_err());
    }
}
