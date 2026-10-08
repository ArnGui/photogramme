//! Assemblage d'une capture : image brute → JPEG nommé dans le dossier de sortie.

use crate::color::{convert_in_place, icc_profile};
use crate::ffargs::expected_rgb_len;
use crate::jpeg::{encode_image, ImageFormat};
use crate::naming::{shot_file_name, unique_path};
use crate::probe::VideoInfo;
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub path: String,
    pub file_name: String,
    pub frame: u64,
    pub timecode: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub quality: u8,
    /// Plan d'origine (export par plans).
    #[serde(default)]
    pub shot: Option<u32>,
}

/// Encode l'image RVB brute fournie par FFmpeg (conversion de gamma
/// éventuelle, voir `color.rs`) et l'écrit sans jamais écraser un fichier
/// existant (écriture via `.part` puis renommage).
pub fn capture_from_raw(
    info: &VideoInfo,
    frame: u64,
    raw: &[u8],
    settings: &Settings,
    out_dir: &Path,
) -> Result<CaptureResult, String> {
    capture_from_raw_shot(info, frame, None, raw, settings, out_dir)
}

/// Variante avec numéro de plan (export en lot).
pub fn capture_from_raw_shot(
    info: &VideoInfo,
    frame: u64,
    shot: Option<u32>,
    raw: &[u8],
    settings: &Settings,
    out_dir: &Path,
) -> Result<CaptureResult, String> {
    let profile = settings.export.color;
    if profile.converts() {
        let mut v = raw.to_vec();
        convert_in_place(&mut v, 3, profile);
        capture_converted(info, frame, shot, &v, settings, out_dir)
    } else {
        capture_converted(info, frame, shot, raw, settings, out_dir)
    }
}

/// Image RVB déjà convertie (voir `color::convert_in_place`) : encodage,
/// profil ICC, écriture.
pub fn capture_converted(
    info: &VideoInfo,
    frame: u64,
    shot: Option<u32>,
    px: &[u8],
    settings: &Settings,
    out_dir: &Path,
) -> Result<CaptureResult, String> {
    let expected = expected_rgb_len(info);
    if px.len() < expected {
        return Err(format!(
            "Incomplete frame: {} bytes received instead of {} (end of film or damaged file?).",
            px.len(),
            expected
        ));
    }
    if px.len() > expected {
        return Err(format!(
            "Too much data: {} bytes received instead of {}. Read bug in the app, capture cancelled.",
            px.len(),
            expected
        ));
    }
    if !out_dir.is_dir() {
        return Err("The output folder no longer exists.".into());
    }
    let icc = icc_profile(settings.export.color);
    let fmt = settings.export.format;
    let data = encode_image(px, info.out_width, info.out_height, false, fmt, settings.quality, settings.chroma, icc.as_deref())?;
    write_image(info, frame, shot, &data, fmt, info.out_width, info.out_height, settings.quality, out_dir)
}

/// Image composée par l'interface (overlay) : RVBA, dimensions libres
/// (l'overlay peut ajouter des marges et une bande de palette). Les pixels
/// ont déjà été convertis avant d'être envoyés à l'interface : seul le
/// profil ICC est ajouté ici.
#[allow(clippy::too_many_arguments)]
pub fn capture_from_rgba(
    info: &VideoInfo,
    frame: u64,
    shot: Option<u32>,
    rgba: &[u8],
    width: u32,
    height: u32,
    settings: &Settings,
    out_dir: &Path,
) -> Result<CaptureResult, String> {
    // Bornes du JPEG (65 535 px) et de la surface d'un Canvas Chromium (~268 Mpx).
    if width == 0 || height == 0 || width > 65_535 || height > 65_535 || width as u64 * height as u64 > 268_435_456 {
        return Err("Invalid composition size.".into());
    }
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(format!(
            "Incomplete composition: {} bytes for {}×{} px.",
            rgba.len(),
            width,
            height
        ));
    }
    if !out_dir.is_dir() {
        return Err("The output folder no longer exists.".into());
    }
    let icc = icc_profile(settings.export.color);
    let fmt = settings.export.format;
    let data = encode_image(rgba, width, height, true, fmt, settings.quality, settings.chroma, icc.as_deref())?;
    write_image(info, frame, shot, &data, fmt, width, height, settings.quality, out_dir)
}

/// Écrit un fichier sans jamais écraser l'existant : `.part` puis renommage.
pub fn write_new_file(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, data).map_err(|e| format!("Cannot write file: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Cannot write file: {e}")
    })
}

#[allow(clippy::too_many_arguments)]
fn write_image(
    info: &VideoInfo,
    frame: u64,
    shot: Option<u32>,
    data: &[u8],
    fmt: ImageFormat,
    width: u32,
    height: u32,
    quality: u8,
    out_dir: &Path,
) -> Result<CaptureResult, String> {
    let timecode = info.tc(frame);
    let path = unique_path(out_dir, &shot_file_name(&info.file_name, &timecode, shot, fmt.extension()));
    write_new_file(&path, data)?;

    Ok(CaptureResult {
        file_name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        frame,
        timecode,
        bytes: data.len() as u64,
        width,
        height,
        quality: if fmt == ImageFormat::Png { 100 } else { quality },
        shot,
    })
}

/// Une ligne du CSV d'export.
#[derive(Debug, Clone, Default)]
pub struct CsvRow {
    pub capture: Option<CaptureResult>,
    /// Plan [début, fin) de l'image, s'il est connu.
    pub span: Option<(u64, u64)>,
    /// Nom du clip (liste de montage importée).
    pub clip: Option<String>,
    /// Palette de l'image (codes hexadécimaux), si demandée.
    pub palette: Option<Vec<String>>,
}

/// Liste des images exportées, en CSV pour Excel (UTF-8 avec BOM, « ; »).
pub fn export_csv(info: &VideoInfo, rows: &[CsvRow]) -> String {
    let with_palette = rows.iter().any(|r| r.palette.is_some());
    let mut s = String::from("\u{FEFF}file;frame;frame_tc;shot;clip;shot_tc_in;shot_tc_last_frame;shot_length_frames");
    if with_palette {
        s.push_str(";palette");
    }
    s.push_str("\r\n");
    let mut rows: Vec<&CsvRow> = rows.iter().filter(|r| r.capture.is_some()).collect();
    rows.sort_by_key(|r| r.capture.as_ref().map(|c| c.frame));
    for r in rows {
        let c = r.capture.as_ref().expect("filtré");
        let (shot, tin, tout, dur) = match (c.shot, r.span) {
            (Some(n), Some((a, b))) => (n.to_string(), info.tc(a), info.tc(b.saturating_sub(1)), (b - a).to_string()),
            _ => Default::default(),
        };
        s.push_str(&format!(
            "{};{};{};{};{};{};{};{}",
            csv_field(&c.file_name),
            c.frame,
            c.timecode,
            shot,
            csv_field(r.clip.as_deref().unwrap_or("")),
            tin,
            tout,
            dur
        ));
        if with_palette {
            s.push(';');
            s.push_str(&csv_field(&r.palette.as_ref().map(|p| p.join(" ")).unwrap_or_default()));
        }
        s.push_str("\r\n");
    }
    s
}

/// Champ CSV sûr : guillemets si besoin (RFC 4180), et neutralisation des
/// formules (un nom de film commençant par « = » serait exécuté par Excel).
fn csv_field(v: &str) -> String {
    let v = if v.starts_with(['=', '+', '-', '@']) { format!("'{v}") } else { v.to_string() };
    if v.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> VideoInfo {
        let mut i = crate::probe::tests::sample_info(4, 2, 25, 1, 100);
        i.file_name = "Film; v2.mp4".into();
        i
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("photogramme-cap-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn composition_rvba_avec_marges() {
        let dir = tmpdir("rgba");
        let rgba = vec![200u8; 6 * 5 * 4];
        let r = capture_from_rgba(&info(), 30, Some(2), &rgba, 6, 5, &Settings::default(), &dir).unwrap();
        assert_eq!(r.file_name, "Film;_v2_P0002_00-00-01-05.jpg");
        assert_eq!((r.width, r.height, r.shot), (6, 5, Some(2)));
        assert!(std::path::Path::new(&r.path).is_file());
        assert!(capture_from_rgba(&info(), 30, None, &rgba, 6, 4, &Settings::default(), &dir).is_err());
        assert!(capture_from_rgba(&info(), 30, None, &rgba, 65_000, 65_000, &Settings::default(), &dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn png_et_conversion_srgb() {
        let dir = tmpdir("png");
        let mut s = Settings::default();
        s.export.format = ImageFormat::Png;
        s.export.color = crate::color::ColorProfile::Srgb;
        let r = capture_from_raw(&info(), 0, &[128; 24], &s, &dir).unwrap();
        assert!(r.file_name.ends_with(".png"));
        let bytes = std::fs::read(&r.path).unwrap();
        let mut rd = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        assert!(rd.info().icc_profile.is_some(), "profil sRGB intégré");
        let mut buf = vec![0; rd.output_buffer_size().unwrap()];
        rd.next_frame(&mut buf).unwrap();
        assert_eq!(buf[0], 121, "gris 128 converti de γ2,4 vers sRGB");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn timecode_du_fichier_dans_le_nom() {
        let dir = tmpdir("tc");
        let mut i = info();
        i.timecode = crate::timecode::Timecode::from_tag(Some("01:00:00:00"), 25.0);
        let r = capture_from_raw(&i, 25, &[0; 24], &Settings::default(), &dir).unwrap();
        assert_eq!(r.timecode, "01:00:01:00");
        assert!(r.file_name.ends_with("_01-00-01-00.jpg"), "{}", r.file_name);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn csv_pour_excel() {
        let dir = tmpdir("csv");
        let s = Settings::default();
        let a = capture_from_raw_shot(&info(), 50, Some(2), &[0; 24], &s, &dir).unwrap();
        let b = capture_from_raw_shot(&info(), 10, Some(1), &[0; 24], &s, &dir).unwrap();
        let row = |c: CaptureResult, span, clip: Option<&str>| CsvRow { capture: Some(c), span: Some(span), clip: clip.map(Into::into), palette: None };
        let csv = export_csv(&info(), &[row(a.clone(), (40, 75), Some("=B.mov")), row(b, (0, 40), None)]);
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert!(lines[0].starts_with('\u{FEFF}'));
        assert!(!lines[0].contains("palette"));
        assert_eq!(lines[1], "\"Film;_v2_P0001_00-00-00-10.jpg\";10;00:00:00:10;1;;00:00:00:00;00:00:01:14;40");
        assert_eq!(lines[2], "\"Film;_v2_P0002_00-00-02-00.jpg\";50;00:00:02:00;2;'=B.mov;00:00:01:15;00:00:02:24;35");
        let with = export_csv(&info(), &[CsvRow { capture: Some(a), palette: Some(vec!["#000000".into(), "#FFFFFF".into()]), ..Default::default() }]);
        assert!(with.lines().next().unwrap().ends_with(";palette"));
        assert!(with.lines().nth(1).unwrap().ends_with(";#000000 #FFFFFF"));
        assert_eq!(csv_field("=HYPERLINK(1)"), "'=HYPERLINK(1)");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
