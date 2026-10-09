//! Timecode SMPTE : non-drop (HH:MM:SS:FF) et drop-frame (HH:MM:SS;FF).
//!
//! On compte les images à la cadence nominale (23,976 → 24, 29,97 → 30),
//! comme les logiciels de montage. En drop-frame (29,97 et 59,94 seulement),
//! on saute les numéros 00 et 01 (00 à 03 en 59,94) au début de chaque
//! minute, sauf les minutes multiples de 10 : le timecode reste alors calé
//! sur l'horloge (SMPTE ST 12-1).
//!
//! Le timecode de départ du fichier (piste `tmcd` d'un master, souvent
//! 01:00:00:00) est lu par la sonde ; tout timecode affiché ou écrit vaut
//! `départ + numéro d'image`.

use serde::{Deserialize, Serialize};

/// Cadence nominale utilisée pour compter les images.
pub fn nominal_rate(fps: f64) -> u32 {
    fps.round().clamp(1.0, 1000.0) as u32
}

/// Le drop-frame n'existe que pour les cadences NTSC 29,97 et 59,94.
pub fn drop_frame_allowed(fps: f64) -> bool {
    let r = nominal_rate(fps);
    (r == 30 || r == 60) && (fps - r as f64).abs() > 0.005
}

/// Description complète du timecode d'un film.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timecode {
    /// Cadence nominale (24, 25, 30…).
    pub rate: u32,
    pub drop: bool,
    /// Numéro (en images comptées) du timecode de la première image.
    pub start: u64,
}

impl Timecode {
    pub fn zero(fps: f64) -> Self {
        Self { rate: nominal_rate(fps), drop: false, start: 0 }
    }

    /// À partir d'un timecode lu dans le fichier ; `None` ou illisible → 00:00:00:00.
    pub fn from_tag(tag: Option<&str>, fps: f64) -> Self {
        let rate = nominal_rate(fps);
        let Some(t) = tag.map(str::trim).filter(|t| !t.is_empty()) else {
            return Self::zero(fps);
        };
        let drop = (t.contains(';') || t.contains('.')) && drop_frame_allowed(fps);
        match parse_label(t, rate, drop) {
            Some(start) => Self { rate, drop, start },
            None => Self::zero(fps),
        }
    }

    /// Images dans 24 heures (le timecode revient à zéro ensuite).
    pub fn day(&self) -> u64 {
        let r = self.rate as u64;
        if self.drop {
            let d = drop_count(self.rate) as u64;
            r * 86_400 - d * (24 * 60 - 24 * 6)
        } else {
            r * 86_400
        }
    }

    /// Timecode de l'image `frame` du fichier (0 = première image).
    pub fn label(&self, frame: u64) -> String {
        format_count((self.start + frame) % self.day(), self.rate, self.drop)
    }

    /// Image du fichier correspondant à un timecode absolu ; `None` si avant le début.
    pub fn frame_of(&self, label: &str) -> Option<u64> {
        let n = parse_label(label, self.rate, self.drop)?;
        n.checked_sub(self.start)
    }

    pub fn start_label(&self) -> String {
        self.label(0)
    }
}

/// Numéros sautés chaque minute en drop-frame : 2 en 29,97, 4 en 59,94.
fn drop_count(rate: u32) -> u32 {
    if rate >= 60 { 4 } else { 2 }
}

/// Nombre d'images comptées → libellé.
pub fn format_count(count: u64, rate: u32, drop: bool) -> String {
    let r = rate.max(1) as u64;
    let mut n = count;
    if drop {
        let d = drop_count(rate) as u64;
        let per_min = r * 60 - d;
        let per_10 = r * 600 - d * 9;
        let tens = n / per_10;
        let rem = n % per_10;
        n += d * 9 * tens;
        if rem > d {
            n += d * ((rem - d) / per_min);
        }
    }
    let ff = n % r;
    let total_s = n / r;
    let sep = if drop { ';' } else { ':' };
    format!(
        "{:02}:{:02}:{:02}{sep}{:02}",
        total_s / 3600,
        (total_s / 60) % 60,
        total_s % 60,
        ff
    )
}

/// Libellé « HH:MM:SS:FF » (ou « ; », « . » en drop-frame) → nombre d'images comptées.
pub fn parse_label(label: &str, rate: u32, drop: bool) -> Option<u64> {
    let parts: Vec<&str> = label.trim().split([':', ';', '.', ',']).collect();
    if parts.len() != 4 {
        return None;
    }
    let mut v = [0u64; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        v[i] = p.parse().ok()?;
    }
    let [h, m, s, f] = v;
    let r = rate.max(1) as u64;
    if m > 59 || s > 59 || f >= r || h > 99 {
        return None;
    }
    let total = ((h * 60 + m) * 60 + s) * r + f;
    if drop {
        let d = drop_count(rate) as u64;
        // Les numéros sautés (début de minute non multiple de 10) n'existent pas.
        if s == 0 && f < d && m % 10 != 0 {
            return None;
        }
        let minutes = h * 60 + m;
        Some(total - d * (minutes - minutes / 10))
    } else {
        Some(total)
    }
}

/// Raccourci : timecode non-drop depuis 00:00:00:00 (barres, CSV sans film…).
pub fn frame_to_tc(frame: u64, fps: f64) -> String {
    format_count(frame, nominal_rate(fps), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origine_et_cadence_nominale() {
        assert_eq!(frame_to_tc(0, 23.976), "00:00:00:00");
        assert_eq!(frame_to_tc(23, 23.976), "00:00:00:23");
        assert_eq!(frame_to_tc(24, 23.976), "00:00:01:00");
        assert_eq!(frame_to_tc(24 * 3600 + 24 * 61 + 5, 24.0), "01:01:01:05");
        assert_eq!(frame_to_tc(25 * 60 - 1, 25.0), "00:00:59:24");
    }

    #[test]
    fn depart_du_fichier() {
        let tc = Timecode::from_tag(Some("01:00:00:00"), 25.0);
        assert_eq!(tc.label(0), "01:00:00:00");
        assert_eq!(tc.label(26), "01:00:01:01");
        assert_eq!(tc.frame_of("01:00:01:01"), Some(26));
        assert_eq!(tc.frame_of("00:59:59:24"), None, "avant le début du film");
        assert_eq!(Timecode::from_tag(Some("n'importe quoi"), 25.0), Timecode::zero(25.0));
        assert_eq!(Timecode::from_tag(None, 25.0).label(25), "00:00:01:00");
    }

    #[test]
    fn drop_frame_2997_saute_les_bons_numeros() {
        let tc = Timecode { rate: 30, drop: true, start: 0 };
        assert_eq!(tc.label(1799), "00:00:59;29");
        assert_eq!(tc.label(1800), "00:01:00;02", "00 et 01 sautés à la minute 1");
        assert_eq!(tc.label(17_981), "00:09:59;29");
        assert_eq!(tc.label(17_982), "00:10:00;00", "pas de saut à la minute 10");
        // Une heure de 29,97 = 107 892 images : le timecode reste calé sur l'horloge.
        assert_eq!(tc.label(107_892), "01:00:00;00");
    }

    #[test]
    fn drop_frame_aller_retour_exhaustif_sur_une_heure() {
        for (rate, n) in [(30u32, 107_892u64), (60, 215_784)] {
            for c in (0..n).step_by(7) {
                let l = format_count(c, rate, true);
                assert_eq!(parse_label(&l, rate, true), Some(c), "{rate} {l}");
            }
        }
        assert_eq!(parse_label("00:01:00;00", 30, true), None, "numéro sauté");
        assert_eq!(parse_label("00:01:00;02", 30, true), Some(1800));
    }

    #[test]
    fn drop_frame_lu_dans_le_fichier() {
        let tc = Timecode::from_tag(Some("00:59:59;28"), 30000.0 / 1001.0);
        assert!(tc.drop);
        assert_eq!(tc.label(0), "00:59:59;28");
        assert_eq!(tc.label(2), "01:00:00;00");
        // « ; » sur du 25 i/s : le drop-frame n'existe pas, lu comme non-drop.
        let tc = Timecode::from_tag(Some("01:00:00;00"), 25.0);
        assert!(!tc.drop);
        assert_eq!(tc.label(0), "01:00:00:00");
    }

    #[test]
    fn revient_a_zero_apres_24_heures() {
        let tc = Timecode::from_tag(Some("23:59:59:24"), 25.0);
        assert_eq!(tc.label(1), "00:00:00:00");
    }

    #[test]
    fn refuse_les_libelles_invalides() {
        for bad in ["", "1:2:3", "00:60:00:00", "00:00:00:25", "aa:00:00:00", "00:00:00:00:00"] {
            assert_eq!(parse_label(bad, 25, false), None, "{bad}");
        }
    }
}
