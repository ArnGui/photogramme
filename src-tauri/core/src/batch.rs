//! Décodage groupé pour l'export en lot.
//!
//! Lancer un FFmpeg par image coûte 0,1 à 0,3 s (démarrage + décodage depuis
//! l'image-clé précédente). Pour un lot, on regroupe les images proches :
//! un seul FFmpeg se place sur la première, décode en avant et ne sort que
//! les images voulues grâce au filtre `select`. Au-delà d'un certain écart,
//! un nouveau seek coûte moins cher que de tout décoder entre les deux.
//!
//! La précision reste celle de la capture à l'unité : même seek, même
//! conversion de couleurs (voir `ffargs.rs` et le test d'intégration).

use crate::ffargs::{geometry_filter, input_args, seek_seconds};
use crate::probe::VideoInfo;

/// Écart au-delà duquel on relance un seek plutôt que de décoder en continu.
pub const MERGE_GAP_SECONDS: f64 = 3.0;
/// Taille maximale d'un groupe : borne la longueur de l'expression `select`.
pub const MAX_PER_GROUP: usize = 100;

/// Un FFmpeg : se place sur `first`, sort les images `first + offsets[i]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeGroup {
    pub first: u64,
    pub offsets: Vec<u64>,
}

impl DecodeGroup {
    pub fn frames(&self) -> impl Iterator<Item = u64> + '_ {
        self.offsets.iter().map(move |o| self.first + o)
    }
}

/// Regroupe des numéros d'image triés.
pub fn group_frames(sorted: &[u64], fps: f64) -> Vec<DecodeGroup> {
    let gap = (MERGE_GAP_SECONDS * fps).round().max(1.0) as u64;
    let mut groups: Vec<DecodeGroup> = Vec::new();
    for &f in sorted {
        match groups.last_mut() {
            Some(g)
                if g.offsets.len() < MAX_PER_GROUP
                    && f >= g.first
                    && f - (g.first + g.offsets.last().copied().unwrap_or(0)) <= gap =>
            {
                let off = f - g.first;
                if g.offsets.last() != Some(&off) {
                    g.offsets.push(off);
                }
            }
            _ => groups.push(DecodeGroup { first: f, offsets: vec![0] }),
        }
    }
    groups
}

/// Format de pixels en sortie : RVB pour l'encodage direct, RVBA pour la
/// composition Canvas (évite une conversion en JavaScript).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Rgb24,
    Rgba,
}

impl PixelFormat {
    pub fn bpp(self) -> usize {
        match self {
            PixelFormat::Rgb24 => 3,
            PixelFormat::Rgba => 4,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            PixelFormat::Rgb24 => "rgb24",
            PixelFormat::Rgba => "rgba",
        }
    }
}

/// Taille des images décodées : celle d'export, ou réduite (planche contact).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutSize {
    pub width: u32,
    pub height: u32,
}

impl OutSize {
    pub fn full(info: &VideoInfo) -> Self {
        Self { width: info.out_width, height: info.out_height }
    }
}

pub fn frame_len(size: OutSize, fmt: PixelFormat) -> usize {
    size.width as usize * size.height as usize * fmt.bpp()
}

/// Arguments FFmpeg d'un groupe. Décodage processeur, comme la capture à
/// l'unité (voir journal des décisions).
pub fn group_args(info: &VideoInfo, group: &DecodeGroup, fmt: PixelFormat, size: OutSize) -> Vec<String> {
    let ss = seek_seconds(group.first, info.fps_num, info.fps_den);
    // Après un seek précis, `n` repart de 0 sur l'image visée.
    let expr = group
        .offsets
        .iter()
        .map(|o| format!("eq(n,{o})"))
        .collect::<Vec<_>>()
        .join("+");
    let vf = format!("select='{expr}',{}", geometry_filter(info, fmt.name(), size.width, size.height));
    let mut a = input_args(info, Some(ss));
    a.extend([
        "-map".into(),
        "0:v:0".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-vf".into(),
        vf,
        "-frames:v".into(),
        group.offsets.len().to_string(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        fmt.name().into(),
        "-".into(),
    ]);
    a
}

/// Découpe un flux d'octets en images de taille fixe.
pub struct FrameSplitter {
    frame_len: usize,
    buf: Vec<u8>,
}

impl FrameSplitter {
    pub fn new(frame_len: usize) -> Self {
        Self { frame_len, buf: Vec::with_capacity(frame_len) }
    }

    /// Ajoute des octets ; renvoie les images complétées.
    pub fn push(&mut self, mut data: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while !data.is_empty() {
            let take = (self.frame_len - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buf.len() == self.frame_len {
                out.push(std::mem::replace(&mut self.buf, Vec::with_capacity(self.frame_len)));
            }
        }
        out
    }

    /// Octets restants d'une image incomplète.
    pub fn leftover(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> VideoInfo {
        let mut i = crate::probe::tests::sample_info(4, 2, 24, 1, 2400);
        i.path = r"D:\x'y.mp4".into();
        i
    }

    #[test]
    fn regroupe_les_images_proches() {
        // Écart de fusion à 24 i/s : 72 images.
        let g = group_frames(&[10, 20, 82, 155, 2000, 2000], 24.0);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0], DecodeGroup { first: 10, offsets: vec![0, 10, 72] });
        assert_eq!(g[1].first, 155);
        assert_eq!(g[2], DecodeGroup { first: 2000, offsets: vec![0] }, "doublon retiré");
        assert_eq!(g[0].frames().collect::<Vec<_>>(), vec![10, 20, 82]);
    }

    #[test]
    fn taille_de_groupe_bornee() {
        let frames: Vec<u64> = (0..250).collect();
        let g = group_frames(&frames, 24.0);
        assert_eq!(g.iter().map(|x| x.offsets.len()).collect::<Vec<_>>(), vec![100, 100, 50]);
        assert_eq!(g[1].first, 100);
    }

    #[test]
    fn arguments_d_un_groupe() {
        let a = group_args(&info(), &DecodeGroup { first: 48, offsets: vec![0, 3] }, PixelFormat::Rgba, OutSize::full(&info()));
        let at = |k: &str| a.iter().position(|x| x == k).unwrap();
        assert_eq!(a[at("-i") + 1], r"D:\x'y.mp4");
        assert!(at("-ss") < at("-i"), "seek rapide avant -i");
        assert_eq!(a[at("-frames:v") + 1], "2");
        let vf = &a[at("-vf") + 1];
        assert!(vf.starts_with("select='eq(n,0)+eq(n,3)',scale="), "{vf}");
        assert!(vf.ends_with("format=rgba"));
        assert_eq!(a.last().unwrap(), "-");
        assert_eq!(frame_len(OutSize::full(&info()), PixelFormat::Rgba), 32);
        let small = group_args(&info(), &DecodeGroup { first: 0, offsets: vec![0] }, PixelFormat::Rgba, OutSize { width: 2, height: 2 });
        assert!(small.iter().any(|x| x.contains("w=2:h=2")));
    }

    #[test]
    fn decoupe_le_flux() {
        let mut s = FrameSplitter::new(4);
        assert!(s.push(&[1, 2, 3]).is_empty());
        let f = s.push(&[4, 5, 6, 7, 8, 9, 10]);
        assert_eq!(f, vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]]);
        assert_eq!(s.leftover(), 2);
    }
}
