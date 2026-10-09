//! Construction des arguments FFmpeg.
//!
//! Règle de sécurité : on produit toujours un tableau d'arguments, jamais une
//! chaîne passée à un shell. Un nom de fichier piégé ne peut rien injecter.
//!
//! Géométrie : toutes les sorties passent par `geometry_filter`, qui remet
//! les pixels carrés (SAR) puis applique la rotation. FFmpeg est lancé avec
//! `-noautorotate` : la rotation automatique insère son propre filtre, qui
//! échoue sur des images restées en mémoire GPU ; on la fait donc nous-mêmes,
//! partout de la même façon.

use crate::probe::VideoInfo;

/// Instant de seek pour obtenir exactement l'image `frame`.
///
/// Avec `-ss` placé avant `-i`, FFmpeg recule à l'image-clé précédente, décode
/// en avant et sort la première image dont le timestamp est ≥ au seek.
/// L'image n commence à n/fps : on vise un quart d'image plus tôt pour ne
/// jamais tomber sur l'image suivante à cause d'un arrondi flottant.
pub fn seek_seconds(frame: u64, fps_num: u32, fps_den: u32) -> f64 {
    let t = (frame as f64 - 0.25) * fps_den as f64 / fps_num as f64;
    t.max(0.0)
}

/// Filtre de rotation (après conversion en RVB, sur l'image finale).
/// Conventions vérifiées contre la rotation automatique de FFmpeg 8.1 :
/// 90 → sens antihoraire, 270 → sens horaire, 180 → double miroir.
pub fn rotation_filter(rotation: u32) -> Option<&'static str> {
    match rotation {
        90 => Some("transpose=cclock"),
        270 => Some("transpose=clock"),
        180 => Some("hflip,vflip"),
        _ => None,
    }
}

/// Conversion YUV → RVB 8 bits pleine plage avec la bonne matrice, à la
/// taille `out_w`×`out_h` (taille APRÈS rotation), puis rotation.
///
/// Sans `in_color_matrix` explicite, une vidéo HD non taguée serait convertie
/// en BT.601 : léger décalage de teinte, et palette faussée.
pub fn geometry_filter(info: &VideoInfo, pix_fmt: &str, out_w: u32, out_h: u32) -> String {
    let (sw, sh) = if info.quarter_turn() { (out_h, out_w) } else { (out_w, out_h) };
    let resized = sw != info.width || sh != info.height;
    // Redimensionnement (anamorphose, vignettes) : lanczos ; sinon simple
    // conversion de couleurs, bicubic suffit (aucun pixel interpolé).
    let flags = if resized { "lanczos+accurate_rnd+full_chroma_int" } else { "bicubic+accurate_rnd+full_chroma_int" };
    let mut f = format!(
        "scale=w={sw}:h={sh}:in_color_matrix={}:in_range={}:out_range=pc:flags={flags},format={pix_fmt}",
        info.color_matrix, info.color_range
    );
    if let Some(r) = rotation_filter(info.rotation) {
        f.push(',');
        f.push_str(r);
    }
    f
}

/// Conversion à la taille d'export (pixels carrés, rotation appliquée).
pub fn rgb_filter_fmt(info: &VideoInfo, pix_fmt: &str) -> String {
    geometry_filter(info, pix_fmt, info.out_width, info.out_height)
}

pub fn rgb_filter(info: &VideoInfo) -> String {
    rgb_filter_fmt(info, "rgb24")
}

/// Début commun : sans bannière, sans entrée standard, sans rotation automatique.
pub fn input_args(info: &VideoInfo, seek: Option<f64>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-noautorotate"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(ss) = seek {
        a.push("-ss".into());
        a.push(format!("{ss:.6}"));
    }
    a.push("-i".into());
    a.push(info.path.clone());
    a
}

/// Extraction d'une image en RVB brut sur la sortie standard.
///
/// Décodage CPU volontaire : pour une image isolée, l'initialisation du NVDEC
/// coûte plus cher que le décodage lui-même.
pub fn capture_args(info: &VideoInfo, frame: u64) -> Vec<String> {
    capture_args_fmt(info, frame, "rgb24")
}

/// Capture d'une image en `rgb24` ou `rgba` (aperçu et composition Canvas).
pub fn capture_args_fmt(info: &VideoInfo, frame: u64, pix_fmt: &str) -> Vec<String> {
    capture_args_sized(info, frame, pix_fmt, info.out_width, info.out_height)
}

/// Capture d'une image à une taille donnée (vignettes, vérification de synchro).
pub fn capture_args_sized(info: &VideoInfo, frame: u64, pix_fmt: &str, w: u32, h: u32) -> Vec<String> {
    let mut a = input_args(info, Some(seek_seconds(frame, info.fps_num, info.fps_den)));
    a.extend(
        [
            "-map".into(),
            "0:v:0".into(),
            "-frames:v".into(),
            "1".into(),
            "-an".into(),
            "-sn".into(),
            "-dn".into(),
            "-vf".into(),
            geometry_filter(info, pix_fmt, w, h),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            pix_fmt.into(),
            "-".into(),
        ],
    );
    a
}

/// Taille attendue d'une image RVB brute à la taille d'export.
pub fn expected_rgb_len(info: &VideoInfo) -> usize {
    info.out_width as usize * info.out_height as usize * 3
}

/// Taille réduite qui garde le rapport d'affichage, dimensions paires.
pub fn fit_width(info: &VideoInfo, width: u32) -> (u32, u32) {
    let w = width.clamp(2, info.out_width.max(2));
    let w = (w / 2 * 2).max(2);
    let h = ((w as f64 * info.out_height as f64 / info.out_width as f64 / 2.0).round() as u32 * 2).max(2);
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::tests::sample_info;

    fn info() -> VideoInfo {
        let mut i = sample_info(1920, 1080, 24000, 1001, 240);
        i.path = r"C:\Films\a; rm -rf.mp4".into();
        i
    }

    #[test]
    fn seek_dans_l_image_visee() {
        let (n, d) = (24000, 1001);
        for frame in [1_u64, 37, 1000, 161_462] {
            let t = seek_seconds(frame, n, d);
            let start = frame as f64 * d as f64 / n as f64;
            let prev = (frame - 1) as f64 * d as f64 / n as f64;
            assert!(t < start && t > prev, "frame {frame}: {t}");
        }
        assert_eq!(seek_seconds(0, n, d), 0.0);
    }

    #[test]
    fn le_chemin_reste_un_seul_argument() {
        let a = capture_args(&info(), 10);
        let i = a.iter().position(|x| x == "-i").unwrap();
        assert_eq!(a[i + 1], r"C:\Films\a; rm -rf.mp4");
        assert_eq!(a.last().unwrap(), "-");
        assert!(a.contains(&"-noautorotate".to_string()));
    }

    #[test]
    fn filtre_avec_matrice_explicite() {
        let f = rgb_filter(&info());
        assert!(f.contains("in_color_matrix=bt709"));
        assert!(f.contains("in_range=tv"));
        assert!(f.contains("w=1920:h=1080"));
        assert!(f.contains("flags=bicubic"), "pas de redimensionnement : {f}");
        assert!(f.ends_with("format=rgb24"));
    }

    #[test]
    fn anamorphose_et_rotation() {
        let mut i = info();
        i.width = 1440;
        i.sar_num = 4;
        i.sar_den = 3;
        let f = rgb_filter(&i);
        assert!(f.contains("w=1920:h=1080") && f.contains("lanczos"), "{f}");

        let mut i = info();
        i.rotation = 90;
        i.out_width = 1080;
        i.out_height = 1920;
        let f = rgb_filter(&i);
        // On redimensionne dans l'orientation du flux, puis on tourne.
        assert!(f.contains("w=1920:h=1080") && f.ends_with("format=rgb24,transpose=cclock"), "{f}");
        assert_eq!(expected_rgb_len(&i), 1080 * 1920 * 3);
        let small = geometry_filter(&i, "rgb24", 180, 320);
        assert!(small.contains("w=320:h=180"), "{small}");
    }

    #[test]
    fn taille_reduite() {
        assert_eq!(fit_width(&info(), 480), (480, 270));
        assert_eq!(fit_width(&info(), 9999), (1920, 1080));
        assert_eq!(expected_rgb_len(&info()), 1920 * 1080 * 3);
    }
}
