//! Projets : ce qui survit à la fermeture de l'application, film par film.
//!
//! Pour chaque film ouvert, un dossier `projects/<clé>/` contient :
//! - `analysis.bin` : l'analyse (scores, code-barre, vignettes), pour ne pas
//!   la relancer. Binaire, versionné, rejeté si le film a changé depuis.
//! - `cuts.json` : les coupes importées d'une liste de montage, noms de clips compris.
//! - `session.json` : l'état de l'interface (plans cochés, coupes, in/out…),
//!   écrit en continu. Son contenu appartient à l'interface : ici, on le borne
//!   et on l'écrit sans risque de fichier à moitié écrit.
//!
//! La clé vient du chemin du film : rouvrir le même fichier retrouve son projet.
//! L'empreinte (taille + date de modification) dit si c'est encore le même film.

use crate::analysis::{Analysis, Decoder, Geometry};
use crate::cuts::ImportedCuts;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Plafond de l'état d'interface enregistré (un projet normal pèse quelques Ko).
pub const MAX_SESSION_BYTES: usize = 8 * 1024 * 1024;
/// Place maximale occupée par les analyses gardées ; les plus anciennes partent d'abord.
pub const MAX_ANALYSIS_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const MAGIC: &[u8; 4] = b"PGAN";
const VERSION: u32 = 1;

/// Clé stable d'un film : FNV-1a 64 bits du chemin (insensible à la casse sous
/// Windows, où `D:\Film.mp4` et `d:\film.MP4` sont le même fichier).
/// FNV plutôt que le hachage de la bibliothèque standard, qui peut changer
/// d'une version de Rust à l'autre et perdrait tous les projets.
pub fn film_key(path: &str) -> String {
    let norm = if cfg!(windows) { path.to_lowercase() } else { path.to_string() };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in norm.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Ce qui permet de reconnaître que le fichier n'a pas changé.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    pub size: u64,
    /// Date de modification, en millisecondes depuis 1970.
    pub modified: u64,
}

impl Fingerprint {
    pub fn of(path: &Path) -> io::Result<Self> {
        let m = fs::metadata(path)?;
        let modified = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(Self { size: m.len(), modified })
    }
}

/// Dossier du projet d'un film.
pub fn project_dir(root: &Path, film_path: &str) -> PathBuf {
    root.join(film_key(film_path))
}

/* ───────────── Écriture sûre ───────────── */

/// Écrit dans un fichier temporaire puis le renomme : un plantage pendant
/// l'écriture laisse l'ancienne version intacte, jamais un fichier tronqué.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/* ───────────── Analyse ───────────── */

/// Analyse sérialisée, empreinte du film en tête.
pub fn encode_analysis(a: &Analysis, fp: &Fingerprint) -> Vec<u8> {
    let thumbs: usize = a.thumbs.values().map(|t| t.len() + 12).sum();
    let mut out = Vec::with_capacity(80 + a.scores.len() * 4 + a.columns.len() + thumbs);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&fp.size.to_le_bytes());
    out.extend_from_slice(&fp.modified.to_le_bytes());
    out.extend_from_slice(&a.frames.to_le_bytes());
    out.push(match a.decoder {
        Decoder::Gpu => 1,
        Decoder::Cpu => 0,
    });
    let g = &a.geometry;
    for v in [g.analysis_w, g.analysis_h, g.thumb_w, g.thumb_h] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(a.scores.len() as u64).to_le_bytes());
    for s in &a.scores {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out.extend_from_slice(&(a.columns.len() as u64).to_le_bytes());
    out.extend_from_slice(&a.columns);
    out.extend_from_slice(&(a.thumbs.len() as u64).to_le_bytes());
    for (f, jpg) in &a.thumbs {
        out.extend_from_slice(&f.to_le_bytes());
        out.extend_from_slice(&(jpg.len() as u32).to_le_bytes());
        out.extend_from_slice(jpg);
    }
    out
}

/// Pourquoi une analyse gardée n'est pas reprise.
#[derive(Debug, PartialEq)]
pub enum LoadError {
    /// Le film a changé (réexporté, remplacé) : l'analyse ne lui correspond plus.
    Stale,
    /// Fichier abîmé ou d'une autre version : on l'ignore.
    Invalid(&'static str),
}

struct Reader<'a> {
    b: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], LoadError> {
        if n > self.b.len() {
            return Err(LoadError::Invalid("truncated"));
        }
        let (head, rest) = self.b.split_at(n);
        self.b = rest;
        Ok(head)
    }
    fn u32(&mut self) -> Result<u32, LoadError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, LoadError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// Longueur lue dans le fichier, refusée si elle dépasse ce qu'il reste à lire.
    fn len(&mut self, item: usize) -> Result<usize, LoadError> {
        let n = self.u64()?;
        match usize::try_from(n).ok().and_then(|n| n.checked_mul(item)) {
            Some(bytes) if bytes <= self.b.len() => Ok(n as usize),
            _ => Err(LoadError::Invalid("bad length")),
        }
    }
}

/// Relit une analyse. `expected` : empreinte actuelle du film.
pub fn decode_analysis(bytes: &[u8], expected: &Fingerprint) -> Result<Analysis, LoadError> {
    let mut r = Reader { b: bytes };
    if r.take(4)? != MAGIC || r.u32()? != VERSION {
        return Err(LoadError::Invalid("not a Photogramme analysis"));
    }
    let fp = Fingerprint { size: r.u64()?, modified: r.u64()? };
    if fp != *expected {
        return Err(LoadError::Stale);
    }
    let frames = r.u64()?;
    let decoder = match r.take(1)?[0] {
        1 => Decoder::Gpu,
        0 => Decoder::Cpu,
        _ => return Err(LoadError::Invalid("decoder")),
    };
    let geometry = Geometry { analysis_w: r.u32()?, analysis_h: r.u32()?, thumb_w: r.u32()?, thumb_h: r.u32()? };
    let n = r.len(4)?;
    let scores = r.take(n * 4)?.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect::<Vec<_>>();
    let n = r.len(1)?;
    let columns = r.take(n)?.to_vec();
    let count = r.len(12)?;
    let mut thumbs = BTreeMap::new();
    for _ in 0..count {
        let f = r.u64()?;
        let len = r.u32()? as usize;
        thumbs.insert(f, r.take(len)?.to_vec());
    }
    if !r.b.is_empty() {
        return Err(LoadError::Invalid("trailing bytes"));
    }
    // Mêmes invariants que ceux que produit l'analyse : sinon le code-barre ou
    // la détection liraient hors des données.
    let col_len = geometry.thumb_h as usize * 3;
    let frames_us = usize::try_from(frames).map_err(|_| LoadError::Invalid("frames"))?;
    if frames == 0 || col_len == 0 || geometry.thumb_w == 0 {
        return Err(LoadError::Invalid("empty"));
    }
    if scores.len() != frames_us || frames_us.checked_mul(col_len) != Some(columns.len()) {
        return Err(LoadError::Invalid("sizes"));
    }
    if thumbs.keys().any(|&f| f >= frames) {
        return Err(LoadError::Invalid("thumbnail out of range"));
    }
    Ok(Analysis { frames, scores, columns, geometry, thumbs, decoder })
}

/* ───────────── Coupes importées ───────────── */

/// Coupes importées telles qu'enregistrées (les noms de clips compris,
/// que l'interface ne reçoit pas).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCuts {
    pub fingerprint: Fingerprint,
    pub format: String,
    pub file_name: String,
    pub cuts: Vec<u64>,
    pub names: Vec<(u64, String)>,
    pub shots: usize,
    pub warnings: Vec<String>,
}

impl StoredCuts {
    pub fn new(c: &ImportedCuts, fingerprint: Fingerprint) -> Self {
        Self {
            fingerprint,
            format: c.format.clone(),
            file_name: c.file_name.clone(),
            cuts: c.cuts.clone(),
            names: c.names.iter().map(|(f, n)| (*f, n.clone())).collect(),
            shots: c.shots,
            warnings: c.warnings.clone(),
        }
    }

    /// Coupes reprises, si elles sont cohérentes avec un film de `frames` images.
    pub fn into_cuts(self, frames: u64) -> Option<ImportedCuts> {
        let sorted = self.cuts.windows(2).all(|w| w[0] < w[1]);
        if !sorted || self.cuts.iter().any(|&c| c == 0 || c >= frames) || self.cuts.len() > 100_000 {
            return None;
        }
        Some(ImportedCuts {
            format: self.format,
            file_name: self.file_name,
            cuts: self.cuts,
            names: self.names.into_iter().collect(),
            shots: self.shots,
            warnings: self.warnings,
        })
    }
}

/* ───────────── Ménage ───────────── */

/// Supprime les analyses les plus anciennes (date de dernière utilisation)
/// jusqu'à repasser sous `max_bytes`. `keep` n'est jamais supprimée.
/// Renvoie le nombre d'octets libérés.
pub fn prune_analyses(root: &Path, max_bytes: u64, keep: Option<&Path>) -> u64 {
    let mut files = analyses(root);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    let mut freed = 0;
    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total -= size;
            freed += size;
        }
    }
    freed
}

/// Place occupée par les analyses gardées.
pub fn analyses_size(root: &Path) -> u64 {
    analyses(root).iter().map(|f| f.1).sum()
}

/// (chemin, taille, date) de chaque `analysis.bin`.
fn analyses(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let Ok(dirs) = fs::read_dir(root) else { return Vec::new() };
    dirs.flatten()
        .map(|d| d.path().join("analysis.bin"))
        .filter_map(|p| {
            let m = fs::metadata(&p).ok()?;
            Some((p, m.len(), m.modified().unwrap_or(UNIX_EPOCH)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Analysis {
        let mut thumbs = BTreeMap::new();
        thumbs.insert(0, vec![0xFF, 0xD8, 1, 2]);
        thumbs.insert(24, vec![0xFF, 0xD8, 3]);
        Analysis {
            frames: 48,
            scores: (0..48).map(|i| i as f32 * 0.5).collect(),
            columns: (0..48 * 2 * 3).map(|i| (i % 251) as u8).collect(),
            geometry: Geometry { analysis_w: 64, analysis_h: 36, thumb_w: 4, thumb_h: 2 },
            thumbs,
            decoder: Decoder::Gpu,
        }
    }

    fn same(a: &Analysis, b: &Analysis) {
        assert_eq!(a.frames, b.frames);
        assert_eq!(a.scores, b.scores);
        assert_eq!(a.columns, b.columns);
        assert_eq!(a.geometry, b.geometry);
        assert_eq!(a.thumbs, b.thumbs);
        assert_eq!(a.decoder, b.decoder);
    }

    const FP: Fingerprint = Fingerprint { size: 1234, modified: 5678 };

    #[test]
    fn analysis_round_trip() {
        let a = sample();
        let b = decode_analysis(&encode_analysis(&a, &FP), &FP).unwrap();
        same(&a, &b);
    }

    #[test]
    fn changed_film_is_stale() {
        let bytes = encode_analysis(&sample(), &FP);
        assert_eq!(decode_analysis(&bytes, &Fingerprint { size: 1234, modified: 9 }).err(), Some(LoadError::Stale));
        assert_eq!(decode_analysis(&bytes, &Fingerprint { size: 1, modified: 5678 }).err(), Some(LoadError::Stale));
    }

    #[test]
    fn damaged_files_are_rejected_without_panic() {
        let bytes = encode_analysis(&sample(), &FP);
        // Toutes les troncatures, et chaque octet altéré : jamais de panique ni d'allocation folle.
        for n in 0..bytes.len() {
            assert!(decode_analysis(&bytes[..n], &FP).is_err(), "truncated at {n}");
        }
        for i in 0..bytes.len() {
            let mut b = bytes.clone();
            b[i] ^= 0xFF;
            let _ = decode_analysis(&b, &FP);
        }
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode_analysis(&extra, &FP).is_err());
        // Longueur énorme annoncée : refusée avant toute allocation.
        let mut huge = bytes[..4 + 4 + 16 + 8 + 1 + 16].to_vec();
        huge.extend_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(decode_analysis(&huge, &FP).err(), Some(LoadError::Invalid("bad length")));
    }

    #[test]
    fn inconsistent_sizes_are_rejected() {
        let mut a = sample();
        a.columns.pop();
        assert!(decode_analysis(&encode_analysis(&a, &FP), &FP).is_err());
        let mut a = sample();
        a.scores.pop();
        assert!(decode_analysis(&encode_analysis(&a, &FP), &FP).is_err());
        let mut a = sample();
        a.thumbs.insert(48, vec![1]);
        assert!(decode_analysis(&encode_analysis(&a, &FP), &FP).is_err());
    }

    #[test]
    fn key_is_stable_and_path_based() {
        // Valeur figée : une clé qui change ferait perdre tous les projets existants.
        assert_eq!(film_key("/films/a.mp4").len(), 16);
        assert_ne!(film_key("/films/a.mp4"), film_key("/films/b.mp4"));
        assert_eq!(film_key(""), "cbf29ce484222325");
        assert_eq!(film_key("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn stored_cuts_keep_clip_names() {
        let mut names = BTreeMap::new();
        names.insert(0, "A001".to_string());
        names.insert(10, "B002".to_string());
        let c = ImportedCuts {
            format: "EDL".into(),
            file_name: "cut.edl".into(),
            cuts: vec![10, 20],
            names,
            shots: 3,
            warnings: vec!["w".into()],
        };
        let s = StoredCuts::new(&c, FP);
        let json = serde_json::to_string(&s).unwrap();
        let back: StoredCuts = serde_json::from_str(&json).unwrap();
        assert_eq!(back.clone().into_cuts(48), Some(c));
        assert_eq!(back.clone().into_cuts(15), None, "cut beyond the film");
        let mut bad = back;
        bad.cuts = vec![20, 10];
        assert_eq!(bad.into_cuts(48), None, "unsorted");
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("photogramme-project-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let d = temp("atomic");
        let p = d.join("x").join("session.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        assert!(!p.with_extension("tmp").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn prune_removes_oldest_first_and_keeps_current() {
        let d = temp("prune");
        let mk = |k: &str, size: usize, age_s: u64| {
            let p = d.join(k).join("analysis.bin");
            write_atomic(&p, &vec![0u8; size]).unwrap();
            let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_s);
            fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
            p
        };
        let old = mk("old", 100, 300);
        let mid = mk("mid", 100, 200);
        let cur = mk("cur", 100, 400);
        assert_eq!(analyses_size(&d), 300);
        // Plafond 150 : « cur » est la plus ancienne mais protégée, puis « old » part, puis « mid ».
        let freed = prune_analyses(&d, 150, Some(&cur));
        assert_eq!(freed, 200);
        assert!(cur.exists() && !old.exists() && !mid.exists());
        assert_eq!(prune_analyses(&d, 1000, None), 0);
        fs::remove_dir_all(&d).unwrap();
    }
}
