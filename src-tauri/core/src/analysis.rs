//! Passe d'analyse du film entier, en un seul décodage :
//! scores de changement de plan (`scdet`), vignettes et colonnes du code-barre.
//!
//! Chaîne GPU (RTX 3080) :
//!   NVDEC → `scale_cuda` (réduction à 480 px sur le GPU) → `hwdownload`
//!   → `scdet` → `metadata` (scores sur stderr) → vignette RVB 160 px sur stdout.
//! Le GPU fait le gros du travail (décodage + réduction) ; le processeur ne
//! voit plus que des images de 480 px.
//!
//! Pourquoi lire le score de CHAQUE image plutôt que laisser `scdet` trancher ?
//! Parce que le seuil devient alors réglable en direct, sans relancer
//! l'analyse : `scdet` coupe quand `score >= seuil`, on applique exactement
//! la même règle côté Rust (voir `shots.rs`).

use crate::jpeg::{encode_rgb, Chroma};
use crate::probe::VideoInfo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Largeur de l'image sur laquelle `scdet` calcule ses scores.
pub const ANALYSIS_WIDTH: u32 = 480;
/// Largeur des vignettes (liste des plans) et base du code-barre.
pub const THUMB_WIDTH: u32 = 160;
/// Seuil minimal proposé dans l'interface. Les vignettes des débuts de plan
/// potentiels sont gardées à partir de ce score, pour que tout seuil choisi
/// ensuite ait une vignette exacte pour ses plans courts.
pub const THRESHOLD_FLOOR: f32 = 3.0;
/// Au-delà, on encode la vignette sans attendre son score (mémoire bornée).
const MAX_PENDING: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decoder {
    /// NVDEC + scale_cuda.
    Gpu,
    /// Décodage et réduction par le processeur.
    Cpu,
}

/// Dimensions utilisées pendant l'analyse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub analysis_w: u32,
    pub analysis_h: u32,
    pub thumb_w: u32,
    pub thumb_h: u32,
}

fn even(x: f64) -> u32 {
    (((x / 2.0).round() as u32) * 2).max(2)
}

/// Dimensions dans l'orientation des photogrammes (rotation appliquée,
/// pixels carrés) : vignettes et code-barre sont dans le bon sens.
pub fn geometry(info: &VideoInfo) -> Geometry {
    let ratio = info.out_height as f64 / info.out_width as f64;
    let analysis_w = even(ANALYSIS_WIDTH.min(info.out_width) as f64);
    let thumb_w = even(THUMB_WIDTH.min(analysis_w) as f64);
    Geometry {
        analysis_w,
        analysis_h: even(analysis_w as f64 * ratio),
        thumb_w,
        thumb_h: even(thumb_w as f64 * ratio),
    }
}

/// Chaîne de filtres commune après la réduction : détection, impression des
/// scores sur stderr (descripteur 2, sans tampon), puis vignette RVB.
///
/// Échappement : `pipe\:2` est entre apostrophes pour que le `:` survive aux
/// deux niveaux d'analyse des filtres FFmpeg (graphe puis options).
fn tail_filters(info: &VideoInfo, g: &Geometry) -> String {
    let (tw, th) = stream_dims(info, g.thumb_w, g.thumb_h);
    let mut f = format!(
        "scdet=threshold=100,\
         metadata=mode=print:key=lavfi.scd.score:file='pipe\\:2':direct=1,\
         scale=w={tw}:h={th}:flags=area:in_color_matrix={m}:in_range={r}:out_range=pc,\
         format=rgb24",
        m = info.color_matrix,
        r = info.color_range,
    );
    if let Some(rot) = crate::ffargs::rotation_filter(info.rotation) {
        f.push(',');
        f.push_str(rot);
    }
    f
}

/// Dimensions dans l'orientation du flux (avant rotation).
fn stream_dims(info: &VideoInfo, w: u32, h: u32) -> (u32, u32) {
    if info.quarter_turn() { (h, w) } else { (w, h) }
}

/// Arguments FFmpeg de la passe d'analyse.
pub fn analysis_args(info: &VideoInfo, decoder: Decoder) -> Vec<String> {
    let g = geometry(info);
    let (aw, ah) = stream_dims(info, g.analysis_w, g.analysis_h);
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-noautorotate"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let vf = match decoder {
        Decoder::Gpu => {
            // Les images restent en mémoire GPU jusqu'au `hwdownload`.
            a.extend(
                ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
                    .iter()
                    .map(|s| s.to_string()),
            );
            format!("scale_cuda=w={aw}:h={ah},hwdownload,format=nv12,{}", tail_filters(info, &g))
        }
        Decoder::Cpu => format!("scale=w={aw}:h={ah}:flags=bilinear,{}", tail_filters(info, &g)),
    };
    a.extend(["-i".into(), info.path.clone()]);
    a.extend(
        [
            "-map", "0:v:0", "-an", "-sn", "-dn",
            // Une image décodée = une image en sortie, jamais de doublon ni de saut.
            "-fps_mode", "passthrough",
            "-vf",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    a.push(vf);
    a.extend(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"].iter().map(|s| s.to_string()));
    a
}

/// Message d'erreur NVDEC/CUDA reconnaissable : on bascule alors sur le processeur.
pub fn looks_like_gpu_failure(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    // « device » seul serait trop large (« No space left on device ») : on
    // garde les formulations des erreurs d'initialisation du GPU.
    ["cuda", "nvdec", "cuvid", "hwaccel", "hwdownload", "scale_cuda", "nvcuda", "device creation", "no device", "device type"]
        .iter()
        .any(|k| s.contains(k))
}

/// Résultat de l'analyse, conservé en mémoire tant que le film est ouvert.
#[derive(Debug, Clone)]
pub struct Analysis {
    /// Nombre d'images réellement décodées.
    pub frames: u64,
    /// Score `scdet` de chaque image (0 à 100). `scores[n]` compare n à n-1.
    pub scores: Vec<f32>,
    /// Une colonne par image : `thumb_h` pixels RVB (moyenne de chaque ligne).
    pub columns: Vec<u8>,
    pub geometry: Geometry,
    /// Vignettes JPEG : une par seconde + débuts de plan potentiels.
    pub thumbs: BTreeMap<u64, Vec<u8>>,
    pub decoder: Decoder,
}

impl Analysis {
    pub fn column_len(&self) -> usize {
        self.geometry.thumb_h as usize * 3
    }

    /// Vignette disponible la plus proche de `target`, de préférence dans
    /// l'intervalle [start, end). Renvoie le numéro d'image de la vignette.
    pub fn nearest_thumb(&self, target: u64, start: u64, end: u64) -> Option<u64> {
        let inside = self
            .thumbs
            .range(start..end.max(start + 1))
            .map(|(f, _)| *f)
            .min_by_key(|f| f.abs_diff(target));
        inside.or_else(|| {
            let before = self.thumbs.range(..=target).next_back().map(|(f, _)| *f);
            let after = self.thumbs.range(target..).next().map(|(f, _)| *f);
            match (before, after) {
                (Some(b), Some(a)) => Some(if target - b <= a - target { b } else { a }),
                (b, a) => b.or(a),
            }
        })
    }

    pub fn memory_bytes(&self) -> usize {
        self.scores.len() * 4 + self.columns.len() + self.thumbs.values().map(Vec::len).sum::<usize>()
    }
}

/// Assemble les deux flux de FFmpeg au fil de l'eau :
/// stdout = vignettes RVB brutes, stderr = scores `scdet`.
///
/// Les deux flux arrivent par des tubes distincts, sans ordre garanti entre
/// eux : une vignette peut arriver avant ou après son score. Les vignettes
/// en attente de leur score sont gardées (brutes) puis décidées à l'arrivée
/// du score.
pub struct Analyzer {
    geometry: Geometry,
    frame_len: usize,
    grid_step: u64,
    pending_bytes: Vec<u8>,
    frames: u64,
    columns: Vec<u8>,
    thumbs: BTreeMap<u64, Vec<u8>>,
    waiting: BTreeMap<u64, Vec<u8>>,
    scores: Vec<f32>,
    known: Vec<bool>,
    line: Vec<u8>,
    current_frame: Option<u64>,
    /// Lignes de stderr qui ne sont pas des scores : le vrai message d'erreur.
    other: String,
    decoder: Decoder,
}

impl Analyzer {
    pub fn new(info: &VideoInfo, decoder: Decoder) -> Self {
        let geometry = geometry(info);
        let cap = info.frame_count.min(2_000_000) as usize;
        Self {
            geometry,
            frame_len: geometry.thumb_w as usize * geometry.thumb_h as usize * 3,
            // Une vignette par seconde (cadence nominale).
            grid_step: info.fps.round().max(1.0) as u64,
            pending_bytes: Vec::new(),
            frames: 0,
            columns: Vec::with_capacity(cap * geometry.thumb_h as usize * 3),
            thumbs: BTreeMap::new(),
            waiting: BTreeMap::new(),
            scores: Vec::with_capacity(cap),
            known: Vec::with_capacity(cap),
            line: Vec::new(),
            current_frame: None,
            other: String::new(),
            decoder,
        }
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Données de la sortie standard (vignettes concaténées).
    pub fn push_stdout(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            let need = self.frame_len - self.pending_bytes.len();
            if self.pending_bytes.is_empty() && data.len() >= self.frame_len {
                // Cas courant : une image entière disponible, sans copie intermédiaire.
                let (frame, rest) = data.split_at(self.frame_len);
                self.on_frame(frame);
                data = rest;
            } else {
                let take = need.min(data.len());
                self.pending_bytes.extend_from_slice(&data[..take]);
                data = &data[take..];
                if self.pending_bytes.len() == self.frame_len {
                    let frame = std::mem::take(&mut self.pending_bytes);
                    self.on_frame(&frame);
                }
            }
        }
    }

    /// Données de la sortie d'erreur (scores, éventuels messages).
    pub fn push_stderr(&mut self, data: &[u8]) {
        for &b in data {
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                self.on_line(&String::from_utf8_lossy(&line));
            } else if b != b'\r' {
                self.line.push(b);
            }
        }
    }

    /// Texte de stderr hors scores (message d'erreur de FFmpeg).
    pub fn error_text(&self) -> String {
        let mut s = self.other.trim().to_string();
        if !self.line.is_empty() && !is_metadata_line(&String::from_utf8_lossy(&self.line)) {
            s.push('\n');
            s.push_str(&String::from_utf8_lossy(&self.line));
        }
        s.trim().to_string()
    }

    fn on_line(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if let Some(rest) = line.strip_prefix("frame:") {
            self.current_frame = rest.split_whitespace().next().and_then(|n| n.parse().ok());
        } else if let Some(v) = line.strip_prefix("lavfi.scd.score=") {
            if let (Some(f), Ok(score)) = (self.current_frame, v.trim().parse::<f32>()) {
                self.set_score(f, score);
            }
        } else if self.other.len() < 8192 {
            self.other.push_str(line);
            self.other.push('\n');
        }
    }

    fn set_score(&mut self, frame: u64, score: f32) {
        let i = frame as usize;
        if i >= 50_000_000 {
            return; // garde-fou contre une ligne corrompue
        }
        if self.scores.len() <= i {
            self.scores.resize(i + 1, 0.0);
            self.known.resize(i + 1, false);
        }
        self.scores[i] = if score.is_finite() { score.clamp(0.0, 100.0) } else { 0.0 };
        self.known[i] = true;
        if let Some(rgb) = self.waiting.remove(&frame) {
            if self.scores[i] >= THRESHOLD_FLOOR {
                self.keep_thumb(frame, &rgb);
            }
        }
    }

    fn on_frame(&mut self, rgb: &[u8]) {
        let n = self.frames;
        self.frames += 1;
        self.push_column(rgb);

        let i = n as usize;
        #[allow(clippy::manual_is_multiple_of)] // is_multiple_of exige Rust 1.87
        if n % self.grid_step == 0 {
            self.keep_thumb(n, rgb);
        } else if i < self.known.len() && self.known[i] {
            if self.scores[i] >= THRESHOLD_FLOOR {
                self.keep_thumb(n, rgb);
            }
        } else {
            self.waiting.insert(n, rgb.to_vec());
            if self.waiting.len() > MAX_PENDING {
                // Score introuvable depuis trop longtemps : on garde par prudence.
                if let Some((f, data)) = self.waiting.pop_first() {
                    self.keep_thumb(f, &data);
                }
            }
        }
    }

    /// Moyenne de chaque ligne de la vignette : la colonne du code-barre.
    fn push_column(&mut self, rgb: &[u8]) {
        let w = self.geometry.thumb_w as usize;
        for row in rgb.chunks_exact(w * 3) {
            let mut s = [0u32; 3];
            for px in row.chunks_exact(3) {
                s[0] += px[0] as u32;
                s[1] += px[1] as u32;
                s[2] += px[2] as u32;
            }
            let half = w as u32 / 2;
            self.columns.extend(s.map(|c| ((c + half) / w as u32) as u8));
        }
    }

    fn keep_thumb(&mut self, frame: u64, rgb: &[u8]) {
        if self.thumbs.contains_key(&frame) {
            return;
        }
        if let Ok(jpg) = encode_rgb(rgb, self.geometry.thumb_w, self.geometry.thumb_h, 80, Chroma::C420, false) {
            self.thumbs.insert(frame, jpg);
        }
    }

    /// Termine l'analyse. Les vignettes encore sans score sont décidées
    /// avec les scores connus (absent = pas un début de plan).
    pub fn finish(mut self) -> Analysis {
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.on_line(&String::from_utf8_lossy(&line));
        }
        let waiting = std::mem::take(&mut self.waiting);
        for (f, rgb) in waiting {
            let s = self.scores.get(f as usize).copied().unwrap_or(0.0);
            if s >= THRESHOLD_FLOOR {
                self.keep_thumb(f, &rgb);
            }
        }
        let frames = self.frames;
        self.scores.resize(frames as usize, 0.0);
        Analysis {
            frames,
            scores: self.scores,
            columns: self.columns,
            geometry: self.geometry,
            thumbs: self.thumbs,
            decoder: self.decoder,
        }
    }
}

fn is_metadata_line(l: &str) -> bool {
    let l = l.trim();
    l.starts_with("frame:") || l.starts_with("lavfi.scd.")
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn info(w: u32, h: u32, frames: u64) -> VideoInfo {
        let mut i = crate::probe::tests::sample_info(w, h, 24, 1, frames);
        i.path = r"D:\Films\a b;c.mp4".into();
        i
    }

    #[test]
    fn geometrie_paire_et_proportionnelle() {
        let g = geometry(&info(1920, 1080, 10));
        assert_eq!((g.analysis_w, g.analysis_h, g.thumb_w, g.thumb_h), (480, 270, 160, 90));
        let g = geometry(&info(1998, 836, 10)); // 2,39:1
        assert_eq!((g.thumb_w, g.thumb_h), (160, 66));
        let g = geometry(&info(64, 48, 10));
        assert_eq!((g.analysis_w, g.thumb_w, g.thumb_h), (64, 64, 48));
    }

    #[test]
    fn arguments_gpu_et_cpu() {
        let i = info(1920, 1080, 10);
        let gpu = analysis_args(&i, Decoder::Gpu);
        let at = |a: &[String], k: &str| a.iter().position(|x| x == k).unwrap();
        assert_eq!(gpu[at(&gpu, "-hwaccel") + 1], "cuda");
        assert!(at(&gpu, "-hwaccel") < at(&gpu, "-i"), "-hwaccel doit précéder -i");
        assert_eq!(gpu[at(&gpu, "-i") + 1], r"D:\Films\a b;c.mp4", "chemin = un seul argument");
        let vf = &gpu[at(&gpu, "-vf") + 1];
        assert!(vf.starts_with("scale_cuda=w=480:h=270,hwdownload,format=nv12,scdet="));
        assert!(vf.contains("file='pipe\\:2'"));
        assert!(vf.contains("in_color_matrix=bt709"));
        assert_eq!(gpu[at(&gpu, "-fps_mode") + 1], "passthrough");

        let cpu = analysis_args(&i, Decoder::Cpu);
        assert!(!cpu.iter().any(|x| x.contains("cuda")));
        assert!(cpu[at(&cpu, "-vf") + 1].starts_with("scale=w=480:h=270"));
    }

    #[test]
    fn lit_les_scores_meme_coupes_n_importe_ou() {
        let i = info(4, 2, 3);
        let mut a = Analyzer::new(&i, Decoder::Cpu);
        let text = b"frame:0    pts:0       pts_time:0\nlavfi.scd.score=0.000\nframe:1    pts:512 pts_time:0.04\nlavfi.scd.score=12.5\nframe:2 pts:1 pts_time:1\r\nlavfi.scd.score=0.25\n[h264 @ 0x1] erreur de test\n";
        for chunk in text.chunks(7) {
            a.push_stderr(chunk);
        }
        a.push_stdout(&[10u8; 4 * 2 * 3 * 3]);
        assert_eq!(a.error_text(), "[h264 @ 0x1] erreur de test");
        let r = a.finish();
        assert_eq!(r.frames, 3);
        assert_eq!(r.scores, vec![0.0, 12.5, 0.25]);
    }

    #[test]
    fn colonnes_et_vignettes() {
        // 4 images de 2×2 (vignette = taille d'analyse sur une si petite vidéo).
        let i = info(2, 2, 48);
        let mut a = Analyzer::new(&i, Decoder::Cpu);
        let frame = |v: u8| vec![v, v, v, v, v, v, 0, 0, 0, 100, 100, 100];
        // Score de l'image 30 connu AVANT ses pixels, celui de 40 APRÈS.
        a.push_stderr(b"frame:30 pts:0 pts_time:0\nlavfi.scd.score=20\n");
        for n in 0..48u8 {
            a.push_stdout(&frame(n));
        }
        a.push_stderr(b"frame:40 pts:0 pts_time:0\nlavfi.scd.score=9\nframe:41 pts:0 pts_time:0\nlavfi.scd.score=1\n");
        let r = a.finish();
        assert_eq!(r.frames, 48);
        assert_eq!(r.column_len(), 6);
        // Ligne 0 = moyenne de (n,n,n) et (n,n,n) ; ligne 1 = moyenne de 0 et 100.
        assert_eq!(&r.columns[5 * 6..6 * 6], &[5, 5, 5, 50, 50, 50]);
        let kept: Vec<u64> = r.thumbs.keys().copied().collect();
        assert_eq!(kept, vec![0, 24, 30, 40], "grille 1/s + débuts de plan potentiels");
        assert_eq!(r.nearest_thumb(35, 30, 40), Some(30));
        assert_eq!(r.nearest_thumb(45, 41, 48), Some(40), "rien dans le plan : la plus proche");
    }

    #[test]
    fn detecte_un_echec_gpu() {
        assert!(looks_like_gpu_failure("Cannot load nvcuda.dll"));
        assert!(looks_like_gpu_failure("Device creation failed: -1313558101."));
        assert!(!looks_like_gpu_failure("moov atom not found"));
        assert!(!looks_like_gpu_failure("No space left on device"));
    }

    #[test]
    fn rotation_et_anamorphose_dans_l_analyse() {
        let mut i = info(1920, 1080, 10);
        i.rotation = 90;
        i.out_width = 1080;
        i.out_height = 1920;
        let g = geometry(&i);
        assert_eq!((g.thumb_w, g.thumb_h), (160, 284), "vignettes debout");
        let vf = analysis_args(&i, Decoder::Gpu).into_iter().find(|x| x.starts_with("scale_cuda")).unwrap();
        // 480 px de large dans l'orientation finale (debout) = 854×480 dans celle du flux.
        assert!(vf.starts_with("scale_cuda=w=854:h=480,"), "{vf}");
        assert!(vf.contains("scale=w=284:h=160") && vf.ends_with("transpose=cclock"), "{vf}");
        assert!(analysis_args(&i, Decoder::Cpu).contains(&"-noautorotate".to_string()));
    }
}
