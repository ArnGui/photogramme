//! Découpage en plans à partir des scores `scdet`.
//!
//! Même règle que le filtre : une coupe a lieu à l'image n si
//! `score(n) >= seuil`. On y ajoute une durée minimale de plan, pour qu'un
//! flash ou un fondu rapide ne crée pas une rafale de plans d'une image.

use serde::{Deserialize, Serialize};

/// Un plan : images [start, end), `end` exclu.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// Numéro d'affichage, à partir de 1.
    pub index: u32,
    pub start: u64,
    pub end: u64,
    /// Score de la coupe qui ouvre le plan (0 pour le premier).
    pub score: f32,
}

impl Shot {
    pub fn len(&self) -> u64 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// Score d'une coupe ajoutée à la main ou importée d'une liste de montage.
pub const MANUAL_SCORE: f32 = -1.0;

/// Plans délimités par une liste de coupes (importées), plus les coupes
/// ajoutées à la main. Aucune durée minimale : ce sont des coupes voulues.
pub fn from_cuts(cuts: &[u64], frames: u64, extra: &[u64]) -> Vec<Shot> {
    let mut all: Vec<(u64, f32)> = cuts.iter().chain(extra).map(|&c| (c, MANUAL_SCORE)).collect();
    build(&mut all, frames)
}

/// Découpe en plans d'après les scores, plus les coupes ajoutées à la main.
pub fn detect_with(scores: &[f32], frames: u64, threshold: f32, min_len: u64, extra: &[u64]) -> Vec<Shot> {
    let mut cuts: Vec<(u64, f32)> = detect(scores, frames, threshold, min_len)
        .into_iter()
        .skip(1)
        .map(|s| (s.start, s.score))
        .collect();
    cuts.extend(extra.iter().map(|&c| (c, MANUAL_SCORE)));
    build(&mut cuts, frames)
}

fn build(cuts: &mut Vec<(u64, f32)>, frames: u64) -> Vec<Shot> {
    if frames == 0 {
        return Vec::new();
    }
    cuts.retain(|(c, _)| *c > 0 && *c < frames);
    // Même image : la coupe détectée (avec son score) l'emporte.
    cuts.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)));
    cuts.dedup_by_key(|c| c.0);
    let mut shots = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0u64;
    let mut score = 0.0f32;
    for (i, (cut, s)) in cuts.iter().enumerate() {
        shots.push(Shot { index: i as u32 + 1, start, end: *cut, score });
        start = *cut;
        score = *s;
    }
    shots.push(Shot { index: shots.len() as u32 + 1, start, end: frames, score });
    shots
}

/// Découpe `frames` images en plans.
pub fn detect(scores: &[f32], frames: u64, threshold: f32, min_len: u64) -> Vec<Shot> {
    if frames == 0 {
        return Vec::new();
    }
    let min_len = min_len.max(1);
    let mut cuts: Vec<(u64, f32)> = Vec::new();
    let mut start = 0u64;
    for (i, &s) in scores.iter().enumerate().skip(1) {
        let i = i as u64;
        if i >= frames {
            break;
        }
        if s >= threshold && i - start >= min_len {
            cuts.push((i, s));
            start = i;
        }
    }
    // Dernier plan trop court : on le rattache au précédent.
    if let Some(&(last, _)) = cuts.last() {
        if frames - last < min_len {
            cuts.pop();
        }
    }

    let mut shots = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0u64;
    let mut score = 0.0f32;
    for (i, (cut, s)) in cuts.into_iter().enumerate() {
        shots.push(Shot { index: i as u32 + 1, start, end: cut, score });
        start = cut;
        score = s;
    }
    shots.push(Shot { index: shots.len() as u32 + 1, start, end: frames, score });
    shots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coupes_ajoutees_et_importees() {
        let sc = scores(100, &[(40, 30.0)]);
        let s = detect_with(&sc, 100, 10.0, 5, &[10, 40, 0, 100, 150]);
        assert_eq!(s.iter().map(|x| (x.start, x.end)).collect::<Vec<_>>(), vec![(0, 10), (10, 40), (40, 100)]);
        assert_eq!(s[1].score, MANUAL_SCORE);
        assert_eq!(s[2].score, 30.0, "la coupe détectée garde son score");
        let s = from_cuts(&[50, 20], 60, &[55]);
        assert_eq!(s.iter().map(|x| x.start).collect::<Vec<_>>(), vec![0, 20, 50, 55]);
        assert_eq!(s.last().unwrap().end, 60);
        assert!(from_cuts(&[], 0, &[]).is_empty());
    }

    fn scores(n: usize, cuts: &[(usize, f32)]) -> Vec<f32> {
        let mut v = vec![0.5; n];
        v[0] = 0.0;
        for &(i, s) in cuts {
            v[i] = s;
        }
        v
    }

    #[test]
    fn coupe_au_seuil_inclus() {
        let s = scores(120, &[(48, 26.0), (72, 10.0)]);
        let p = detect(&s, 120, 10.0, 1);
        let spans: Vec<_> = p.iter().map(|x| (x.start, x.end)).collect();
        assert_eq!(spans, vec![(0, 48), (48, 72), (72, 120)]);
        assert_eq!(p[1].score, 26.0);
        assert_eq!(p.iter().map(|x| x.index).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(detect(&s, 120, 10.1, 1).len(), 2, "10 < 10,1 : pas de coupe");
    }

    #[test]
    fn duree_minimale() {
        // Flash : coupes à 48 et 50.
        let s = scores(120, &[(48, 30.0), (50, 30.0), (115, 30.0)]);
        let p = detect(&s, 120, 10.0, 12);
        let spans: Vec<_> = p.iter().map(|x| (x.start, x.end)).collect();
        // 50 est trop près de 48 ; 115 laisserait un dernier plan de 5 images.
        assert_eq!(spans, vec![(0, 48), (48, 120)]);
    }

    #[test]
    fn cas_limites() {
        assert!(detect(&[], 0, 10.0, 1).is_empty());
        let p = detect(&[0.0], 1, 10.0, 1);
        assert_eq!((p[0].start, p[0].end), (0, 1));
        // Plus de scores que d'images annoncées : on borne.
        let s = scores(10, &[(9, 50.0)]);
        assert_eq!(detect(&s, 5, 10.0, 1).len(), 1);
        // Image 0 ignorée même avec un gros score.
        let mut s = scores(10, &[]);
        s[0] = 90.0;
        assert_eq!(detect(&s, 10, 10.0, 1).len(), 1);
    }
}
