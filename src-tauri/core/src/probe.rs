//! Sonde vidéo : arguments ffprobe et lecture de sa sortie JSON.
//!
//! Au-delà de la taille et de la cadence, la sonde lit tout ce qui change
//! l'image ou le timecode d'un photogramme :
//! - le format des pixels (SAR) : un fichier anamorphique ou à pixels non
//!   carrés (1440×1080 HDV, 720×576 16:9) est remis à son rapport d'affichage ;
//! - la rotation (téléphones) : appliquée explicitement, voir `ffargs.rs` ;
//! - le timecode de départ (piste `tmcd`, souvent 01:00:00:00 sur un master)
//!   et le drop-frame ;
//! - la courbe de transfert (avertissement si HDR).

use crate::timecode::Timecode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// Origine du timecode affiché et écrit dans les fichiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TimecodeMode {
    /// Timecode du fichier (piste tmcd), 00:00:00:00 s'il n'y en a pas.
    #[default]
    File,
    /// Toujours 00:00:00:00 sur la première image.
    Zero,
}

/// Ce que l'interface et le moteur de capture doivent savoir d'une vidéo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub file_name: String,
    /// Taille codée (pixels du flux).
    pub width: u32,
    pub height: u32,
    /// Format des pixels (1:1 = carrés).
    pub sar_num: u32,
    pub sar_den: u32,
    /// Rotation à appliquer, en degrés : 0, 90, 180 ou 270 (convention FFmpeg).
    pub rotation: u32,
    /// Taille des photogrammes exportés : pixels carrés, rotation appliquée.
    pub out_width: u32,
    pub out_height: u32,
    /// Fréquence exacte sous forme de fraction (ex. 24000/1001).
    pub fps_num: u32,
    pub fps_den: u32,
    pub fps: f64,
    /// Durée en secondes.
    pub duration: f64,
    pub frame_count: u64,
    pub codec: String,
    pub profile: String,
    pub pix_fmt: String,
    /// Matrice YUV→RVB retenue pour la conversion : "bt709", "bt601" ou "bt2020".
    pub color_matrix: String,
    /// Plage d'entrée : "tv" (limitée 16-235) ou "pc" (pleine).
    pub color_range: String,
    /// Courbe de transfert déclarée ("bt709", "smpte2084"…), vide si absente.
    pub color_transfer: String,
    /// Timecode utilisé pour l'affichage et les fichiers (selon le réglage).
    pub timecode: Timecode,
    /// Timecode tel qu'écrit dans le fichier (sert à caler un EDL).
    pub file_timecode: Timecode,
    /// Décodable par le décodeur vidéo du GPU : NVDEC d'une carte RTX 30
    /// (Ampere) sous Windows, VideoToolbox d'un Mac Apple Silicon (même règle).
    /// Nom historique gardé : il est enregistré dans les projets en cache.
    pub nvdec_compatible: bool,
    /// Avertissements lisibles, affichés dans l'interface.
    pub warnings: Vec<String>,
}

impl VideoInfo {
    /// Timecode de l'image `frame`.
    pub fn tc(&self, frame: u64) -> String {
        self.timecode.label(frame)
    }

    /// Copie avec le timecode choisi dans les réglages.
    pub fn with_tc_mode(mut self, mode: TimecodeMode) -> Self {
        self.timecode = match mode {
            TimecodeMode::File => self.file_timecode,
            TimecodeMode::Zero => Timecode { start: 0, ..self.file_timecode },
        };
        self
    }

    /// Pixels non carrés : il faut remettre l'image à son rapport d'affichage.
    pub fn needs_desqueeze(&self) -> bool {
        self.sar_num != self.sar_den
    }

    /// Rotation d'un quart de tour : largeur et hauteur s'échangent.
    pub fn quarter_turn(&self) -> bool {
        self.rotation == 90 || self.rotation == 270
    }
}

/// Arguments ffprobe : tous les flux (le timecode peut être porté par une
/// piste de données `tmcd`), sortie JSON.
pub fn probe_args(path: &str) -> Vec<String> {
    [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,\
         r_frame_rate,avg_frame_rate,nb_frames,duration,color_space,color_range,color_transfer:\
         stream_tags=timecode:stream_side_data=rotation:stream_disposition=attached_pic:\
         format=duration:format_tags=timecode",
        "-of",
        "json",
        path,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn parse_ratio(s: &str, sep: char) -> Option<(u32, u32)> {
    let (n, d) = s.split_once(sep)?;
    let n: u32 = n.trim().parse().ok()?;
    let d: u32 = d.trim().parse().ok()?;
    if n == 0 || d == 0 {
        None
    } else {
        Some((n, d))
    }
}

fn parse_rate(s: &str) -> Option<(u32, u32)> {
    parse_ratio(s, '/')
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn as_str(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn even(x: f64) -> u32 {
    (((x / 2.0).round() as u32) * 2).max(2)
}

/// Le NVDEC des RTX 30 décode le H.264 en 8 bits 4:2:0 uniquement,
/// et le HEVC en 4:2:0 8/10 bits (pas de 4:2:2).
/// Source : NVIDIA Video Encode and Decode GPU Support Matrix.
///
/// La même règle vaut pour VideoToolbox sur Apple Silicon : H.264 seulement en
/// 8 bits 4:2:0, HEVC en 8 et 10 bits 4:2:0.
pub fn nvdec_ampere_compatible(codec: &str, pix_fmt: &str) -> bool {
    match codec {
        "h264" => matches!(pix_fmt, "yuv420p" | "yuvj420p" | "nv12"),
        "hevc" => matches!(pix_fmt, "yuv420p" | "yuvj420p" | "nv12" | "yuv420p10le" | "p010le"),
        _ => false,
    }
}

/// Rotation du flux ramenée à 0, 90, 180 ou 270.
fn normalize_rotation(deg: f64) -> u32 {
    let q = ((deg / 90.0).round() as i64).rem_euclid(4);
    (q * 90) as u32
}

/// Taille des photogrammes : largeur corrigée du format des pixels, puis rotation.
pub fn output_size(width: u32, height: u32, sar: (u32, u32), rotation: u32) -> (u32, u32) {
    let (w, h) = if sar.0 == sar.1 {
        (width, height)
    } else {
        (even(width as f64 * sar.0 as f64 / sar.1 as f64), height)
    };
    if rotation == 90 || rotation == 270 { (h, w) } else { (w, h) }
}

fn is_video(s: &Value) -> bool {
    s.get("codec_type").and_then(|t| t.as_str()) == Some("video")
        && s.get("disposition")
            .and_then(|d| d.get("attached_pic"))
            .and_then(as_u64)
            .unwrap_or(0)
            == 0
}

/// Timecode : celui du flux vidéo, sinon d'une piste de données (tmcd),
/// sinon du conteneur.
fn timecode_tag(root: &Value, video: &Value) -> Option<String> {
    let tag = |v: &Value| v.get("tags").and_then(|t| t.get("timecode")).and_then(|t| t.as_str()).map(str::to_string);
    tag(video)
        .or_else(|| {
            root.get("streams")
                .and_then(|s| s.as_array())
                .and_then(|a| a.iter().find_map(|s| (s.get("codec_type").and_then(|t| t.as_str()) == Some("data")).then(|| tag(s)).flatten()))
        })
        .or_else(|| root.get("format").and_then(tag))
}

/// Transforme la sortie JSON de ffprobe en `VideoInfo`.
pub fn parse_probe(json: &str, path: &str) -> Result<VideoInfo, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("Unreadable ffprobe output: {e}"))?;
    // Même flux que `-map 0:v:0` côté FFmpeg : la première piste vidéo
    // (une pochette intégrée est ignorée par les deux).
    let stream = root
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|a| a.iter().find(|s| is_video(s)))
        .ok_or_else(|| "No video stream found in this file.".to_string())?;

    let width = stream.get("width").and_then(as_u64).unwrap_or(0) as u32;
    let height = stream.get("height").and_then(as_u64).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Err("Frame size not found.".into());
    }

    let r_rate = stream.get("r_frame_rate").map(as_str).unwrap_or_default();
    let avg_rate = stream.get("avg_frame_rate").map(as_str).unwrap_or_default();
    let (fps_num, fps_den) = parse_rate(&avg_rate)
        .or_else(|| parse_rate(&r_rate))
        .ok_or_else(|| "Frame rate not found.".to_string())?;
    let fps = fps_num as f64 / fps_den as f64;

    let duration = stream
        .get("duration")
        .and_then(as_f64)
        .or_else(|| root.get("format").and_then(|f| f.get("duration")).and_then(as_f64))
        .unwrap_or(0.0);

    let frame_count = stream
        .get("nb_frames")
        .and_then(as_u64)
        .filter(|n| *n > 0)
        .unwrap_or_else(|| (duration * fps).round().max(0.0) as u64);

    let codec = stream.get("codec_name").map(as_str).unwrap_or_default();
    let profile = stream.get("profile").map(as_str).unwrap_or_default();
    let pix_fmt = stream.get("pix_fmt").map(as_str).unwrap_or_default();
    let color_space = stream.get("color_space").map(as_str).unwrap_or_default();
    let range_tag = stream.get("color_range").map(as_str).unwrap_or_default();
    let color_transfer = stream.get("color_transfer").map(as_str).unwrap_or_default();

    let mut warnings = Vec::new();

    // Format des pixels, réduit (4:3, 16:15…). « 0:1 » = inconnu = carrés.
    let (sar_num, sar_den) = stream
        .get("sample_aspect_ratio")
        .map(as_str)
        .and_then(|s| parse_ratio(&s, ':'))
        .map(|(n, d)| {
            let g = gcd(n as u64, d as u64) as u32;
            (n / g, d / g)
        })
        .unwrap_or((1, 1));

    let rotation = stream
        .get("side_data_list")
        .and_then(|l| l.as_array())
        .and_then(|a| a.iter().find_map(|d| d.get("rotation").and_then(as_f64)))
        .map(normalize_rotation)
        .unwrap_or(0);

    let (out_width, out_height) = output_size(width, height, (sar_num, sar_den), rotation);
    if out_width > 65_535 || out_height > 65_535 {
        return Err("Frame too large for a JPEG (65,535 px maximum).".into());
    }
    if sar_num != sar_den {
        warnings.push(format!(
            "Non-square pixels ({sar_num}:{sar_den}): stills are resized to the display aspect, {out_width}×{out_height}."
        ));
    }
    if rotation != 0 {
        warnings.push(format!("Rotation metadata ({rotation}°): stills are rotated upright, {out_width}×{out_height}."));
    }

    let color_matrix = match color_space.as_str() {
        "bt709" => "bt709",
        "smpte170m" | "bt470bg" => "bt601",
        "bt2020nc" | "bt2020c" => "bt2020",
        _ => {
            let guess = if height.max(width) >= 1280 || height >= 720 { "bt709" } else { "bt601" };
            warnings.push(format!(
                "Color matrix not tagged in the file: assuming {}.",
                guess.to_uppercase().replace("BT", "BT.")
            ));
            guess
        }
    }
    .to_string();

    let color_range = if range_tag == "pc" || pix_fmt.starts_with("yuvj") {
        "pc"
    } else {
        "tv"
    }
    .to_string();

    if matches!(color_transfer.as_str(), "smpte2084" | "arib-std-b67") {
        warnings.push(format!(
            "HDR file ({}): Photogramme expects SDR Rec.709, stills will look flat and desaturated.",
            if color_transfer == "smpte2084" { "PQ" } else { "HLG" }
        ));
    }

    if codec != "h264" {
        warnings.push(format!(
            "Codec \"{codec}\": Photogramme is designed for H.264, the preview may not work."
        ));
    }

    let nvdec_compatible = nvdec_ampere_compatible(&codec, &pix_fmt);
    if codec == "h264" && !nvdec_compatible {
        warnings.push(format!(
            "H.264 in {pix_fmt}: the GPU decoder ({}) cannot decode it, analysis will run on the CPU.",
            crate::analysis::GPU_DECODER
        ));
    }

    if let (Some(a), Some(r)) = (parse_rate(&avg_rate), parse_rate(&r_rate)) {
        let a = a.0 as f64 / a.1 as f64;
        let r = r.0 as f64 / r.1 as f64;
        if (a - r).abs() / r > 0.001 {
            warnings.push(
                "Frame rate may be variable: frame accuracy is not guaranteed."
                    .into(),
            );
        }
    }

    let tag = timecode_tag(&root, stream);
    let file_timecode = Timecode::from_tag(tag.as_deref(), fps);
    if let Some(t) = tag.as_deref() {
        if file_timecode.start == 0 && !t.trim_start_matches(['0', ':', ';', '.']).is_empty() {
            warnings.push(format!("Unreadable timecode \"{t}\" in the file: counting from 00:00:00:00."));
        }
    }

    let file_name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    Ok(VideoInfo {
        path: path.to_string(),
        file_name,
        width,
        height,
        sar_num,
        sar_den,
        rotation,
        out_width,
        out_height,
        fps_num,
        fps_den,
        fps,
        duration,
        frame_count,
        codec,
        profile,
        pix_fmt,
        color_matrix,
        color_range,
        color_transfer,
        timecode: file_timecode,
        file_timecode,
        nvdec_compatible,
        warnings,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"{
        "programs": [],
        "streams": [{
            "index": 0, "codec_type": "video",
            "codec_name": "h264", "profile": "High", "width": 1920, "height": 1080,
            "pix_fmt": "yuv420p", "color_range": "tv", "color_space": "bt709", "color_transfer": "bt709",
            "sample_aspect_ratio": "1:1",
            "r_frame_rate": "24000/1001", "avg_frame_rate": "24000/1001",
            "duration": "6734.333333", "nb_frames": "161463",
            "disposition": {"attached_pic": 0}
        }],
        "format": { "duration": "6734.400000" }
    }"#;

    /// `VideoInfo` minimal pour les tests des autres modules.
    pub fn sample_info(w: u32, h: u32, fps_num: u32, fps_den: u32, frames: u64) -> VideoInfo {
        let json = SAMPLE
            .replace("\"width\": 1920", &format!("\"width\": {w}"))
            .replace("\"height\": 1080", &format!("\"height\": {h}"))
            .replace("24000/1001", &format!("{fps_num}/{fps_den}"))
            .replace("161463", &frames.to_string());
        parse_probe(&json, "a.mp4").unwrap()
    }

    #[test]
    fn lit_un_h264_standard() {
        let i = parse_probe(SAMPLE, r"D:\Films\mon film.mp4").unwrap();
        assert_eq!((i.width, i.height), (1920, 1080));
        assert_eq!((i.out_width, i.out_height), (1920, 1080));
        assert_eq!((i.fps_num, i.fps_den), (24000, 1001));
        assert!((i.fps - 23.976).abs() < 0.001);
        assert_eq!(i.frame_count, 161_463);
        assert_eq!(i.color_matrix, "bt709");
        assert_eq!(i.color_range, "tv");
        assert!(i.nvdec_compatible);
        assert_eq!(i.tc(0), "00:00:00:00");
        assert!(i.warnings.is_empty(), "{:?}", i.warnings);
    }

    #[test]
    fn anamorphose_remise_au_format_d_affichage() {
        let json = SAMPLE.replace("\"width\": 1920", "\"width\": 1440").replace("\"1:1\"", "\"4:3\"");
        let i = parse_probe(&json, "hdv.mov").unwrap();
        assert_eq!((i.sar_num, i.sar_den), (4, 3));
        assert_eq!((i.out_width, i.out_height), (1920, 1080));
        assert!(i.needs_desqueeze());
        assert!(i.warnings.iter().any(|w| w.contains("Non-square")));
        // 720×576 en 16:9 (SAR 64:45) → 1024×576.
        assert_eq!(output_size(720, 576, (64, 45), 0), (1024, 576));
        // SAR inconnu (0:1) = pixels carrés.
        let json = SAMPLE.replace("\"1:1\"", "\"0:1\"");
        assert!(!parse_probe(&json, "a.mp4").unwrap().needs_desqueeze());
    }

    #[test]
    fn rotation_d_un_telephone() {
        let json = SAMPLE.replace(
            r#""disposition": {"attached_pic": 0}"#,
            r#""disposition": {"attached_pic": 0}, "side_data_list": [{"rotation": -90}]"#,
        );
        let i = parse_probe(&json, "phone.mp4").unwrap();
        assert_eq!(i.rotation, 270);
        assert_eq!((i.out_width, i.out_height), (1080, 1920));
        assert_eq!(normalize_rotation(90.0), 90);
        assert_eq!(normalize_rotation(-180.0), 180);
        assert_eq!(normalize_rotation(360.0), 0);
    }

    #[test]
    fn timecode_de_depart_et_drop_frame() {
        let json = SAMPLE.replace(r#""sample_aspect_ratio": "1:1","#, r#""sample_aspect_ratio": "1:1", "tags": {"timecode": "01:00:00:00"},"#);
        let i = parse_probe(&json, "master.mov").unwrap();
        assert_eq!(i.tc(0), "01:00:00:00");
        assert_eq!(i.tc(24), "01:00:01:00");
        assert_eq!(i.clone().with_tc_mode(TimecodeMode::Zero).tc(24), "00:00:01:00");
        assert_eq!(i.with_tc_mode(TimecodeMode::Zero).file_timecode.start_label(), "01:00:00:00");

        // Timecode porté par une piste de données (tmcd), en drop-frame.
        let json = SAMPLE.replace("24000/1001", "30000/1001").replace(
            r#""format": {"#,
            r#""format": {"tags": {}, "#,
        ).replace(
            r#"}],
        "format""#,
            r#"}, {"index": 1, "codec_type": "data", "tags": {"timecode": "00:59:59;28"}}],
        "format""#,
        );
        let i = parse_probe(&json, "ntsc.mov").unwrap();
        assert!(i.timecode.drop);
        assert_eq!(i.tc(2), "01:00:00;00");
    }

    #[test]
    fn ignore_une_pochette_integree() {
        let json = SAMPLE.replace(
            r#""streams": [{"#,
            r#""streams": [{"index": 0, "codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600,
                "disposition": {"attached_pic": 1}}, {"#,
        );
        let i = parse_probe(&json, "a.mp4").unwrap();
        assert_eq!((i.codec.as_str(), i.width), ("h264", 1920));
    }

    #[test]
    fn suppose_bt709_en_hd_non_tagguee_et_previent() {
        let json = SAMPLE.replace(r#""color_space": "bt709","#, "");
        let i = parse_probe(&json, "a.mp4").unwrap();
        assert_eq!(i.color_matrix, "bt709");
        assert!(i.warnings.iter().any(|w| w.contains("BT.709")));
    }

    #[test]
    fn previent_d_un_fichier_hdr() {
        let json = SAMPLE.replace(r#""color_transfer": "bt709""#, r#""color_transfer": "smpte2084""#);
        let i = parse_probe(&json, "a.mp4").unwrap();
        assert!(i.warnings.iter().any(|w| w.contains("HDR")));
    }

    #[test]
    fn signale_le_h264_10_bits_non_nvdec() {
        let json = SAMPLE.replace("yuv420p", "yuv420p10le");
        let i = parse_probe(&json, "a.mp4").unwrap();
        assert!(!i.nvdec_compatible);
        assert!(i.warnings.iter().any(|w| w.contains(crate::analysis::GPU_DECODER)));
    }

    #[test]
    fn calcule_le_nombre_d_images_sans_nb_frames() {
        let json = SAMPLE.replace(r#", "nb_frames": "161463""#, "");
        let i = parse_probe(&json, "a.mkv").unwrap();
        assert_eq!(i.frame_count, (6734.333333_f64 * 24000.0 / 1001.0).round() as u64);
    }

    #[test]
    fn refuse_un_fichier_sans_video() {
        let err = parse_probe(r#"{"streams": [{"codec_type": "audio"}], "format": {}}"#, "a.wav").unwrap_err();
        assert!(err.contains("No video stream"));
    }

    #[test]
    fn previent_d_une_frequence_variable() {
        let json = SAMPLE.replace(r#""avg_frame_rate": "24000/1001""#, r#""avg_frame_rate": "2400/101""#);
        let i = parse_probe(&json, "a.mp4").unwrap();
        assert!(i.warnings.iter().any(|w| w.contains("variable")));
    }
}
