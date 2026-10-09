//! Couleurs dominantes d'une image : k-means dans l'espace CIELAB.
//!
//! Pourquoi Lab ? Une distance euclidienne en Lab suit à peu près l'écart
//! perçu par l'œil ; en RVB, deux verts sombres « proches » numériquement
//! peuvent paraître très différents, et l'inverse. Les centres des groupes
//! sont donc des couleurs perceptivement cohérentes.
//!
//! Déterministe : même image → même palette (graine fixe), indispensable
//! pour que l'aperçu et l'export soient identiques.

use serde::{Deserialize, Serialize};

/// Nombre de points échantillonnés au maximum (≈ 200×200).
const MAX_SAMPLES: usize = 40_000;
const MAX_ITER: usize = 40;
/// Une ligne/colonne est une bande noire si aucun pixel ne dépasse ce niveau.
const BAR_LEVEL: u8 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PaletteSort {
    /// Couleur la plus présente en premier.
    #[default]
    Share,
    /// Cercle chromatique, les gris à la fin.
    Hue,
    /// Du plus sombre au plus clair.
    Lightness,
}

/// Poids des pixels dans le calcul.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PaletteWeighting {
    /// Chaque pixel compte pareil : les grandes surfaces dominent.
    #[default]
    Area,
    /// Les pixels saturés comptent davantage : la petite couleur d'accent
    /// (un manteau rouge dans un plan gris) n'est plus écrasée.
    Accents,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaletteOptions {
    pub count: u8,
    pub sort: PaletteSort,
    /// Ignorer les bandes noires (letterbox) avant le calcul.
    pub ignore_bars: bool,
    pub weighting: PaletteWeighting,
}

impl Default for PaletteOptions {
    fn default() -> Self {
        Self {
            count: 6,
            sort: PaletteSort::Share,
            ignore_bars: true,
            weighting: PaletteWeighting::Area,
        }
    }
}

impl PaletteOptions {
    pub fn sanitized(mut self) -> Self {
        self.count = self.count.clamp(1, 16);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swatch {
    pub hex: String,
    pub rgb: [u8; 3],
    /// Part des pixels de ce groupe, de 0 à 1.
    pub share: f32,
    /// Coordonnées Lab, utiles au tri et au débogage.
    pub lab: [f32; 3],
}

fn srgb_to_linear_lut() -> [f32; 256] {
    let mut t = [0.0f32; 256];
    for (i, v) in t.iter_mut().enumerate() {
        let c = i as f32 / 255.0;
        *v = if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        };
    }
    t
}

fn linear_to_srgb(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let v = if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

// Blanc de référence D65.
const XN: f32 = 0.950_47;
const YN: f32 = 1.0;
const ZN: f32 = 1.088_83;

fn f_lab(t: f32) -> f32 {
    const D: f32 = 6.0 / 29.0;
    if t > D * D * D {
        t.cbrt()
    } else {
        t / (3.0 * D * D) + 4.0 / 29.0
    }
}

fn f_lab_inv(t: f32) -> f32 {
    const D: f32 = 6.0 / 29.0;
    if t > D {
        t * t * t
    } else {
        3.0 * D * D * (t - 4.0 / 29.0)
    }
}

/// RVB linéaire → Lab (matrice sRGB/BT.709, D65).
pub fn linear_rgb_to_lab(r: f32, g: f32, b: f32) -> [f32; 3] {
    let x = 0.412_456_4 * r + 0.357_576_1 * g + 0.180_437_5 * b;
    let y = 0.212_672_9 * r + 0.715_152_2 * g + 0.072_175 * b;
    let z = 0.019_333_9 * r + 0.119_192 * g + 0.950_304_1 * b;
    let (fx, fy, fz) = (f_lab(x / XN), f_lab(y / YN), f_lab(z / ZN));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn lab_to_srgb(lab: [f32; 3]) -> [u8; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let fx = fy + lab[1] / 500.0;
    let fz = fy - lab[2] / 200.0;
    let (x, y, z) = (XN * f_lab_inv(fx), YN * f_lab_inv(fy), ZN * f_lab_inv(fz));
    let r = 3.240_454_2 * x - 1.537_138_5 * y - 0.498_531_4 * z;
    let g = -0.969_266 * x + 1.876_010_8 * y + 0.041_556 * z;
    let b = 0.055_643_4 * x - 0.204_025_9 * y + 1.057_225_2 * z;
    [linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b)]
}

/// Zone utile de l'image, bandes noires retirées : (x0, y0, x1, y1), bornes exclues.
pub fn content_box(px: &[u8], w: usize, h: usize, bpp: usize) -> (usize, usize, usize, usize) {
    let bright = |x: usize, y: usize| {
        let i = (y * w + x) * bpp;
        px[i].max(px[i + 1]).max(px[i + 2]) > BAR_LEVEL
    };
    // Un pixel sur 4 suffit pour décider d'une ligne.
    let row_has = |y: usize| (0..w).step_by(4).chain([w - 1]).any(|x| bright(x, y));
    let col_has =
        |x: usize, y0: usize, y1: usize| (y0..y1).step_by(4).chain([y1 - 1]).any(|y| bright(x, y));
    let Some(y0) = (0..h).find(|&y| row_has(y)) else {
        return (0, 0, w, h); // image noire : tout garder
    };
    let y1 = (0..h).rev().find(|&y| row_has(y)).unwrap() + 1;
    let x0 = (0..w).find(|&x| col_has(x, y0, y1)).unwrap_or(0);
    let x1 = (0..w)
        .rev()
        .find(|&x| col_has(x, y0, y1))
        .map(|x| x + 1)
        .unwrap_or(w);
    (x0, y0, x1, y1)
}

/// Générateur pseudo-aléatoire minimal (xorshift), graine fixe.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn dist2(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    let (d0, d1, d2) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    d0 * d0 + d1 * d1 + d2 * d2
}

/// Poids « accents » : 1 pour un gris, jusqu'à 12 pour une couleur très saturée.
fn accent_weight(lab: &[f32; 3]) -> f32 {
    let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    (1.0 + (chroma / 25.0).powi(2)).min(12.0)
}

/// k-means++ puis itérations de Lloyd, pondérés. Renvoie (centres, effectifs
/// NON pondérés : la part affichée reste une part de surface).
fn kmeans(points: &[[f32; 3]], weights: &[f32], k: usize) -> (Vec<[f32; 3]>, Vec<usize>) {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let n = points.len();
    let mut centers: Vec<[f32; 3]> = vec![points[(rng.next() % n as u64) as usize]];
    let mut d: Vec<f32> = points
        .iter()
        .zip(weights)
        .map(|(p, w)| dist2(p, &centers[0]) * w)
        .collect();
    while centers.len() < k {
        let total: f32 = d.iter().sum();
        if total <= f32::EPSILON {
            break; // moins de couleurs distinctes que demandé
        }
        let mut target = rng.unit() * total;
        let mut idx = n - 1;
        for (i, di) in d.iter().enumerate() {
            target -= di;
            if target <= 0.0 {
                idx = i;
                break;
            }
        }
        let c = points[idx];
        centers.push(c);
        for ((di, p), w) in d.iter_mut().zip(points).zip(weights) {
            *di = di.min(dist2(p, &c) * w);
        }
    }

    let k = centers.len();
    let mut assign = vec![0usize; n];
    let mut counts = vec![0usize; k];
    for it in 0..MAX_ITER {
        let mut changed = 0usize;
        for (a, p) in assign.iter_mut().zip(points) {
            let mut best = 0;
            let mut bd = f32::MAX;
            for (j, c) in centers.iter().enumerate() {
                let dd = dist2(p, c);
                if dd < bd {
                    bd = dd;
                    best = j;
                }
            }
            if *a != best || it == 0 {
                changed += 1;
                *a = best;
            }
        }
        let mut sums = vec![[0f64; 3]; k];
        let mut wsum = vec![0f64; k];
        counts.iter_mut().for_each(|c| *c = 0);
        for ((a, p), w) in assign.iter().zip(points).zip(weights) {
            counts[*a] += 1;
            wsum[*a] += *w as f64;
            for i in 0..3 {
                sums[*a][i] += p[i] as f64 * *w as f64;
            }
        }
        for j in 0..k {
            if counts[j] > 0 {
                centers[j] = sums[j].map(|s| (s / wsum[j]) as f32);
            } else {
                // Groupe vide : on le replace sur le point le plus mal servi.
                let far = (0..n)
                    .max_by(|&x, &y| {
                        dist2(&points[x], &centers[assign[x]])
                            .total_cmp(&dist2(&points[y], &centers[assign[y]]))
                    })
                    .unwrap();
                centers[j] = points[far];
            }
        }
        if changed * 1000 < n && it > 0 {
            break; // moins de 0,1 % des points ont bougé
        }
    }
    (centers, counts)
}

/// Couleurs dominantes d'une image RVB (`bpp` = 3) ou RVBA (`bpp` = 4).
pub fn dominant_colors(
    px: &[u8],
    w: u32,
    h: u32,
    bpp: usize,
    opts: &PaletteOptions,
) -> Vec<Swatch> {
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || px.len() < w * h * bpp || bpp < 3 {
        return Vec::new();
    }
    let opts = opts.sanitized();
    let (x0, y0, x1, y1) = if opts.ignore_bars {
        content_box(px, w, h, bpp)
    } else {
        (0, 0, w, h)
    };
    let area = (x1 - x0) * (y1 - y0);
    let step = ((area as f64 / MAX_SAMPLES as f64).sqrt().ceil() as usize).max(1);

    let lut = srgb_to_linear_lut();
    let mut points = Vec::with_capacity(area / (step * step) + 1);
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            let i = (y * w + x) * bpp;
            points.push(linear_rgb_to_lab(
                lut[px[i] as usize],
                lut[px[i + 1] as usize],
                lut[px[i + 2] as usize],
            ));
        }
    }

    let weights: Vec<f32> = match opts.weighting {
        PaletteWeighting::Area => vec![1.0; points.len()],
        PaletteWeighting::Accents => points.iter().map(accent_weight).collect(),
    };
    let (centers, counts) = kmeans(&points, &weights, opts.count as usize);
    let total = points.len() as f32;
    let mut sw: Vec<Swatch> = centers
        .iter()
        .zip(&counts)
        .filter(|(_, &c)| c > 0)
        .map(|(lab, &c)| {
            let rgb = lab_to_srgb(*lab);
            Swatch {
                hex: format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]),
                rgb,
                share: c as f32 / total,
                lab: *lab,
            }
        })
        .collect();
    sort_swatches(&mut sw, opts.sort);
    sw
}

pub fn sort_swatches(sw: &mut [Swatch], sort: PaletteSort) {
    match sort {
        PaletteSort::Share => sw.sort_by(|a, b| b.share.total_cmp(&a.share)),
        PaletteSort::Lightness => sw.sort_by(|a, b| a.lab[0].total_cmp(&b.lab[0])),
        PaletteSort::Hue => sw.sort_by(|a, b| {
            let key = |s: &Swatch| {
                let chroma = (s.lab[1].powi(2) + s.lab[2].powi(2)).sqrt();
                let hue = s.lab[2].atan2(s.lab[1]).to_degrees().rem_euclid(360.0);
                // Les quasi-gris (chroma < 8) vont à la fin, du sombre au clair.
                if chroma < 8.0 {
                    (1, s.lab[0])
                } else {
                    (0, hue)
                }
            };
            let (ka, kb) = (key(a), key(b));
            ka.0.cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Image en bandes verticales de couleurs données, largeurs données.
    fn bands(colors: &[([u8; 3], usize)], h: usize) -> (Vec<u8>, usize) {
        let w: usize = colors.iter().map(|c| c.1).sum();
        let mut v = Vec::with_capacity(w * h * 3);
        for _ in 0..h {
            for (c, n) in colors {
                for _ in 0..*n {
                    v.extend_from_slice(c);
                }
            }
        }
        (v, w)
    }

    #[test]
    fn aller_retour_lab() {
        let lut = srgb_to_linear_lut();
        for rgb in [
            [0u8, 0, 0],
            [255, 255, 255],
            [224, 164, 59],
            [12, 200, 90],
            [128, 128, 128],
        ] {
            let lab = linear_rgb_to_lab(
                lut[rgb[0] as usize],
                lut[rgb[1] as usize],
                lut[rgb[2] as usize],
            );
            assert_eq!(lab_to_srgb(lab), rgb, "{lab:?}");
        }
        let white = linear_rgb_to_lab(1.0, 1.0, 1.0);
        assert!((white[0] - 100.0).abs() < 0.01 && white[1].abs() < 0.01 && white[2].abs() < 0.01);
    }

    #[test]
    fn retrouve_les_couleurs_et_leurs_parts() {
        let (px, w) = bands(
            &[
                ([200, 30, 30], 50),
                ([20, 60, 200], 30),
                ([240, 220, 40], 20),
            ],
            40,
        );
        let opts = PaletteOptions {
            count: 3,
            sort: PaletteSort::Share,
            ignore_bars: false,
            ..Default::default()
        };
        let p = dominant_colors(&px, w as u32, 40, 3, &opts);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].rgb, [200, 30, 30]);
        assert_eq!(p[1].rgb, [20, 60, 200]);
        assert_eq!(p[2].rgb, [240, 220, 40]);
        assert!((p[0].share - 0.5).abs() < 0.02, "{}", p[0].share);
        assert_eq!(p[0].hex, "#C81E1E");
    }

    #[test]
    fn deterministe_et_rvba() {
        let (px, w) = bands(
            &[([10, 120, 10], 33), ([90, 90, 90], 33), ([250, 140, 0], 34)],
            30,
        );
        let rgba: Vec<u8> = px.chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect();
        let o = PaletteOptions {
            count: 3,
            ..Default::default()
        };
        let a = dominant_colors(&px, w as u32, 30, 3, &o);
        let b = dominant_colors(&rgba, w as u32, 30, 4, &o);
        assert_eq!(a, b);
        assert_eq!(a, dominant_colors(&px, w as u32, 30, 3, &o));
    }

    #[test]
    fn ignore_les_bandes_noires() {
        // 2,39:1 dans du 16:9 : bandes noires en haut et en bas.
        let (w, h) = (64usize, 36usize);
        let mut px = vec![0u8; w * h * 3];
        for y in 5..31 {
            for x in 0..w {
                let i = (y * w + x) * 3;
                px[i..i + 3].copy_from_slice(&[30, 140, 160]);
            }
        }
        assert_eq!(content_box(&px, w, h, 3), (0, 5, 64, 31));
        let p = dominant_colors(
            &px,
            w as u32,
            h as u32,
            3,
            &PaletteOptions {
                count: 2,
                ..Default::default()
            },
        );
        assert_eq!(p.len(), 1, "une seule couleur hors bandes : {p:?}");
        assert_eq!(p[0].rgb, [30, 140, 160]);
        let p = dominant_colors(
            &px,
            w as u32,
            h as u32,
            3,
            &PaletteOptions {
                count: 2,
                ignore_bars: false,
                ..Default::default()
            },
        );
        assert!(p.iter().any(|s| s.rgb == [0, 0, 0]));
    }

    #[test]
    fn tri_par_teinte_et_luminosite() {
        let (px, w) = bands(
            &[
                ([0, 0, 255], 25),
                ([255, 0, 0], 25),
                ([0, 200, 0], 25),
                ([128, 128, 128], 25),
            ],
            10,
        );
        let o = |sort| PaletteOptions {
            count: 4,
            sort,
            ignore_bars: false,
            ..Default::default()
        };
        let hue = dominant_colors(&px, w as u32, 10, 3, &o(PaletteSort::Hue));
        assert_eq!(
            hue.iter().map(|s| s.hex.as_str()).collect::<Vec<_>>(),
            vec!["#FF0000", "#00C800", "#0000FF", "#808080"]
        );
        let light = dominant_colors(&px, w as u32, 10, 3, &o(PaletteSort::Lightness));
        assert_eq!(light[0].hex, "#0000FF");
    }

    #[test]
    fn le_mode_accents_fait_ressortir_la_petite_couleur_saturee() {
        // Dégradé de gris (le décor) et un petit manteau rouge (4 %), 2 couleurs demandées.
        let mut cols: Vec<([u8; 3], usize)> = (0..96)
            .map(|i| ([30 + 2 * i as u8, 30 + 2 * i as u8, 30 + 2 * i as u8], 1))
            .collect();
        cols.push(([200, 20, 25], 4));
        let (px, w) = bands(&cols, 30);
        let acc = PaletteOptions {
            count: 2,
            ignore_bars: false,
            weighting: PaletteWeighting::Accents,
            ..Default::default()
        };
        let b = dominant_colors(&px, w as u32, 30, 3, &acc);
        let red = b
            .iter()
            .find(|s| s.rgb[0] > 180 && s.rgb[1] < 60)
            .expect("accent trouvé");
        assert!(
            (red.share - 0.04).abs() < 0.01,
            "la part reste une part de surface : {}",
            red.share
        );
    }

    #[test]
    fn image_unie_et_entrees_invalides() {
        let px = vec![77u8; 10 * 10 * 3];
        let p = dominant_colors(
            &px,
            10,
            10,
            3,
            &PaletteOptions {
                count: 8,
                ..Default::default()
            },
        );
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].rgb, [77, 77, 77]);
        assert!(dominant_colors(&px, 20, 20, 3, &PaletteOptions::default()).is_empty());
    }
}
