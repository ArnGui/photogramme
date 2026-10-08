//! Tests d'intégration avec un vrai FFmpeg.
//!
//! - précision à l'image près de la capture et de l'export groupé ;
//! - passe d'analyse complète (scdet + vignettes + colonnes) sur une vidéo
//!   dont on connaît les coupes ;
//! - reconnaissance d'un échec GPU (sur une machine sans carte NVIDIA) ;
//! - fichiers difficiles : pixels non carrés, rotation, timecode de départ,
//!   début décalé (start_time ≠ 0), import d'une EDL sur un vrai film.
//!
//! Ignorés automatiquement si `ffmpeg`/`ffprobe` sont introuvables.
//! Exécutables choisis par PHOTOGRAMME_FFMPEG / PHOTOGRAMME_FFPROBE (voir README).
//!
//! Encodeur des vidéos de test : libx264 s'il existe (build GPL), sinon
//! libopenh264 (présent dans le build LGPL utilisé par l'application).

use photogramme_core::analysis::{looks_like_gpu_failure, Analyzer, Decoder};
use photogramme_core::batch::{frame_len, group_args, group_frames, FrameSplitter, OutSize, PixelFormat};
use photogramme_core::{analysis_args, barcode, capture_args, capture_from_raw, cuts, parse_probe, probe_args, shots, Settings, VideoInfo};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn tool(name: &str) -> Option<String> {
    let exe = std::env::var(format!("PHOTOGRAMME_{}", name.to_uppercase())).unwrap_or_else(|_| name.to_string());
    Command::new(&exe).arg("-version").output().ok().filter(|o| o.status.success()).map(|_| exe)
}

fn tools() -> Option<(String, String)> {
    match (tool("ffmpeg"), tool("ffprobe")) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => {
            eprintln!("ffmpeg/ffprobe absents : test ignoré");
            None
        }
    }
}

fn workdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("photogramme-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Encode une source lavfi en H.264 avec le meilleur encodeur disponible.
fn encode(ffmpeg: &str, filter: &str, out: &Path) {
    encode_with(ffmpeg, filter, &[], out)
}

/// Idem, avec des options de sortie en plus (timecode, SAR, décalage…).
fn encode_with(ffmpeg: &str, filter: &str, extra: &[&str], out: &Path) {
    let has_x264 = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("libx264"))
        .unwrap_or(false);
    let codec: &[&str] = if has_x264 {
        // Sans perte, images B et images-clés espacées : le cas difficile.
        &["-c:v", "libx264", "-qp", "0", "-g", "24", "-bf", "2"]
    } else {
        &["-c:v", "libopenh264", "-b:v", "8M", "-g", "24"]
    };
    let status = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", filter])
        .args(codec)
        .args(["-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709"])
        .args(extra)
        .arg(out)
        .status()
        .expect("lancement de ffmpeg");
    assert!(status.success(), "génération de la vidéo de test");
}

fn probe(ffprobe: &str, video: &Path) -> VideoInfo {
    let out = Command::new(ffprobe).args(probe_args(video.to_str().unwrap())).output().unwrap();
    parse_probe(&String::from_utf8_lossy(&out.stdout), video.to_str().unwrap()).unwrap()
}

/// Rampe : l'image n a une luminance Y = 16 + 3n.
fn ramp(ffmpeg: &str, dir: &Path) -> PathBuf {
    let video = dir.join("rampe.mp4");
    encode(ffmpeg, "nullsrc=s=64x48:r=24000/1001:d=3.5,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128", &video);
    video
}

/// Numéro d'image retrouvé à partir de la moyenne du rouge.
/// Y = 16 + 3n en plage limitée → R = 3n·255/219 en pleine plage.
fn frame_from_red(px: &[u8], bpp: usize) -> f64 {
    let mean = px.iter().step_by(bpp).map(|&v| v as f64).sum::<f64>() / (px.len() / bpp) as f64;
    mean / (3.0 * 255.0 / 219.0)
}

/// Référence : décodage séquentiel complet, sans seek. La capture de
/// l'image n doit lui être identique octet pour octet, quel que soit
/// l'encodeur (avec ou sans perte).
fn decode_all(ffmpeg: &str, info: &VideoInfo, fmt: PixelFormat) -> Vec<Vec<u8>> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-noautorotate", "-i", &info.path, "-map", "0:v:0", "-fps_mode", "passthrough", "-vf"])
        .arg(photogramme_core::ffargs::rgb_filter_fmt(info, fmt.name()))
        .args(["-f", "rawvideo", "-pix_fmt", fmt.name(), "-"])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout.chunks(frame_len(OutSize::full(info), fmt)).map(|c| c.to_vec()).collect()
}

/// L'image n se distingue-t-elle de ses voisines ? (sinon le test ne prouve rien pour n)
fn distinct(all: &[Vec<u8>], n: usize) -> bool {
    (n == 0 || all[n] != all[n - 1]) && (n + 1 >= all.len() || all[n] != all[n + 1])
}

#[test]
fn capture_a_l_image_pres() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("capture");
    let video = ramp(&ffmpeg, &dir);
    let info = probe(&ffprobe, &video);
    assert_eq!((info.width, info.height), (64, 48));
    assert_eq!((info.fps_num, info.fps_den), (24000, 1001));

    // Images-clés à 0, 24, 48, 72 : on teste dessus, juste avant et juste après.
    // Au-delà de n = 73, Y dépasserait 235 (fin de la plage limitée).
    let all = decode_all(&ffmpeg, &info, PixelFormat::Rgb24);
    assert_eq!(all.len() as u64, info.frame_count);
    let mut proven = 0;
    for frame in [0_u64, 1, 2, 23, 24, 25, 37, 47, 48, 50, 71, 72, 73] {
        let out = Command::new(&ffmpeg).args(capture_args(&info, frame)).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(out.stdout.len(), 64 * 48 * 3, "image {frame}");
        assert!(out.stdout == all[frame as usize], "image {frame} : différente du décodage séquentiel (lu ≈ {:.2})", frame_from_red(&out.stdout, 3));
        proven += distinct(&all, frame as usize) as u32;
    }
    assert!(proven >= 8, "trop d'images identiques à leurs voisines ({proven}) : vidéo de test inadaptée");

    let out = Command::new(&ffmpeg).args(capture_args(&info, 37)).output().unwrap();
    let res = capture_from_raw(&info, 37, &out.stdout, &Settings::default(), &dir).unwrap();
    assert_eq!(res.file_name, "rampe_00-00-01-13.jpg");
    assert!(std::fs::metadata(&res.path).unwrap().len() > 100);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn export_groupe_a_l_image_pres() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("groupe");
    let info = probe(&ffprobe, &ramp(&ffmpeg, &dir));

    // Écart de fusion à 23,976 i/s : 72 images. Toutes ces images tiennent
    // dans un seul groupe, qui traverse les images-clés 24, 48 et 72.
    let wanted = [3u64, 10, 24, 25, 47, 48, 73];
    let groups = group_frames(&wanted, info.fps);
    assert_eq!(groups.len(), 1);
    for fmt in [PixelFormat::Rgb24, PixelFormat::Rgba] {
        let mut got = Vec::new();
        for g in &groups {
            let out = Command::new(&ffmpeg).args(group_args(&info, g, fmt, OutSize::full(&info))).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let mut sp = FrameSplitter::new(frame_len(OutSize::full(&info), fmt));
            let frames = sp.push(&out.stdout);
            assert_eq!(sp.leftover(), 0);
            assert_eq!(frames.len(), g.offsets.len(), "une image par décalage");
            if fmt == PixelFormat::Rgba {
                assert!(frames[0].iter().skip(3).step_by(4).all(|&a| a == 255), "alpha opaque");
            }
            got.extend(frames);
        }
        let all = decode_all(&ffmpeg, &info, fmt);
        for (w, g) in wanted.iter().zip(&got) {
            assert!(*g == all[*w as usize], "{fmt:?} image {w} : différente du décodage séquentiel");
        }
    }

    // Deux groupes : seek au milieu du film.
    let groups = group_frames(&[2, 80], info.fps);
    assert_eq!(groups.len(), 2);
    let out = Command::new(&ffmpeg).args(group_args(&info, &groups[1], PixelFormat::Rgb24, OutSize::full(&info))).output().unwrap();
    assert_eq!(out.stdout.len(), 64 * 48 * 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Lance FFmpeg et nourrit l'analyseur avec stdout et stderr, comme la
/// couche Tauri le fait avec les événements du plugin shell.
fn run_analysis(ffmpeg: &str, info: &VideoInfo, decoder: Decoder) -> (bool, Analyzer) {
    let mut child = Command::new(ffmpeg)
        .args(analysis_args(info, decoder))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    enum Ev {
        Out(Vec<u8>),
        Err(Vec<u8>),
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t1 = tx.clone();
    let h1 = std::thread::spawn(move || {
        let mut b = vec![0; 8192];
        while let Ok(n) = so.read(&mut b) {
            if n == 0 { break; }
            t1.send(Ev::Out(b[..n].to_vec())).unwrap();
        }
    });
    let h2 = std::thread::spawn(move || {
        let mut b = vec![0; 8192];
        while let Ok(n) = se.read(&mut b) {
            if n == 0 { break; }
            tx.send(Ev::Err(b[..n].to_vec())).unwrap();
        }
    });
    let mut a = Analyzer::new(info, decoder);
    for ev in rx {
        match ev {
            Ev::Out(d) => a.push_stdout(&d),
            Ev::Err(d) => a.push_stderr(&d),
        }
    }
    h1.join().unwrap();
    h2.join().unwrap();
    (child.wait().unwrap().success(), a)
}

#[test]
fn analyse_des_plans_sur_un_vrai_film() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("analyse");
    // Trois plans à 24 i/s : mire (0–47), barres (48–71), Mandelbrot (72–119).
    let video = dir.join("plans.mp4");
    encode(
        &ffmpeg,
        "testsrc2=s=320x180:r=24:d=2[a];smptehdbars=s=320x180:r=24:d=1[b];\
         mandelbrot=s=320x180:r=24,trim=duration=2,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1",
        &video,
    );
    let info = probe(&ffprobe, &video);
    assert_eq!(info.frame_count, 120);

    let (ok, a) = run_analysis(&ffmpeg, &info, Decoder::Cpu);
    assert!(ok, "{}", a.error_text());
    assert_eq!(a.error_text(), "", "aucun message parasite sur stderr");
    let r = a.finish();
    assert_eq!(r.frames, 120);
    assert_eq!(r.scores.len(), 120);
    assert_eq!(r.columns.len(), 120 * r.column_len());

    let cuts: Vec<usize> = (1..120).filter(|&i| r.scores[i] >= 10.0).collect();
    assert_eq!(cuts, vec![48, 72], "scores : {:?}", &r.scores[40..80]);
    let p = shots::detect(&r.scores, r.frames, 10.0, 12);
    assert_eq!(p.iter().map(|s| (s.start, s.end)).collect::<Vec<_>>(), vec![(0, 48), (48, 72), (72, 120)]);
    // Vignette exacte au début de chaque plan, même hors de la grille 1/s.
    for f in [0u64, 24, 48, 72, 96] {
        assert!(r.thumbs.contains_key(&f), "vignette {f} : {:?}", r.thumbs.keys().collect::<Vec<_>>());
    }
    assert_eq!(&r.thumbs[&72][..2], &[0xFF, 0xD8]);

    // Code-barre : les barres SMPTE (plan 2) ne ressemblent pas à la mire.
    let img = barcode::render(&r.columns, r.geometry.thumb_h as usize, r.frames, 120, 4, barcode::BarcodeMode::Average).unwrap();
    let col = |x: usize| &img[x * 3..x * 3 + 3];
    assert_ne!(col(10), col(60));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn echec_gpu_reconnu_pour_le_repli() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("gpu");
    let info = probe(&ffprobe, &ramp(&ffmpeg, &dir));
    let (ok, a) = run_analysis(&ffmpeg, &info, Decoder::Gpu);
    if ok {
        // Machine avec une carte NVIDIA : l'analyse GPU doit être complète.
        let r = a.finish();
        assert_eq!(r.frames, info.frame_count);
        eprintln!("GPU disponible : analyse NVDEC vérifiée ({} images)", r.frames);
    } else {
        let err = a.error_text();
        eprintln!("Sans GPU, message FFmpeg : {err}");
        assert!(looks_like_gpu_failure(&err), "repli CPU non déclenché pour : {err}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Capture brute d'une image, vérifiée en taille.
fn grab(ffmpeg: &str, info: &VideoInfo, frame: u64) -> Vec<u8> {
    let out = Command::new(ffmpeg).args(capture_args(info, frame)).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.stdout.len(), (info.out_width * info.out_height * 3) as usize, "taille de l'image {frame}");
    out.stdout
}

fn mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (*x as f64 - *y as f64).abs()).sum::<f64>() / a.len() as f64
}

#[test]
fn pixels_non_carres_remis_au_format_d_affichage() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("sar");
    let video = dir.join("hdv.mov");
    encode_with(&ffmpeg, "testsrc2=s=240x180:r=25:d=1,setsar=4/3", &[], &video);
    let info = probe(&ffprobe, &video);
    assert_eq!((info.width, info.sar_num, info.sar_den), (240, 4, 3));
    assert_eq!((info.out_width, info.out_height), (320, 180));
    let px = grab(&ffmpeg, &info, 5);
    // Référence : la mise à l'échelle classique iw*sar de FFmpeg.
    let reference = Command::new(&ffmpeg)
        .args(["-v", "error", "-i", video.to_str().unwrap(), "-vf", "select=eq(n\\,5),scale=w=iw*sar:h=ih:in_color_matrix=bt709:in_range=tv:out_range=pc:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"])
        .output()
        .unwrap();
    assert_eq!(reference.stdout.len(), px.len());
    assert!(mean_abs_diff(&px, &reference.stdout) < 0.5, "écart moyen {}", mean_abs_diff(&px, &reference.stdout));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rotation_comme_la_rotation_automatique_de_ffmpeg() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("rot");
    let plain = dir.join("plain.mp4");
    encode(&ffmpeg, "testsrc2=s=160x90:r=25:d=1", &plain);
    for (deg, expect) in [("90", 90u32), ("-90", 270), ("180", 180)] {
        let video = dir.join(format!("rot{expect}.mp4"));
        let st = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-display_rotation", deg, "-i", plain.to_str().unwrap(), "-c", "copy", video.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(st.success());
        let info = probe(&ffprobe, &video);
        assert_eq!(info.rotation, expect);
        let px = grab(&ffmpeg, &info, 10);
        // Référence : FFmpeg avec sa rotation automatique (par défaut).
        let auto = Command::new(&ffmpeg)
            .args(["-v", "error", "-i", video.to_str().unwrap(), "-vf", "select=eq(n\\,10),scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        assert_eq!(auto.stdout.len(), px.len(), "{deg}°");
        // Même conversion de couleurs : quasi identique (≈ 0,01). Mauvais sens : > 100.
        assert!(mean_abs_diff(&px, &auto.stdout) < 0.5, "{deg}° : écart moyen {}", mean_abs_diff(&px, &auto.stdout));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn debut_decale_et_timecode_du_fichier() {
    let Some((ffmpeg, ffprobe)) = tools() else { return };
    let dir = workdir("offset");
    let video = dir.join("decale.mov");
    // Rampe avec un début à 10 s (start_time) et un timecode 10:00:00:00.
    encode_with(
        &ffmpeg,
        "nullsrc=s=64x48:r=25:d=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128",
        &["-output_ts_offset", "10", "-timecode", "10:00:00:00"],
        &video,
    );
    let info = probe(&ffprobe, &video);
    assert_eq!(info.tc(0), "10:00:00:00");
    assert_eq!(info.tc(26), "10:00:01:01");
    let all = decode_all(&ffmpeg, &info, PixelFormat::Rgb24);
    for frame in [0u64, 1, 12, 25, 37] {
        assert!(grab(&ffmpeg, &info, frame) == all[frame as usize], "image {frame} : décalage dû au start_time");
    }
    let res = capture_from_raw(&info, 25, &all[25], &Settings::default(), &dir).unwrap();
    assert_eq!(res.file_name, "decale_10-00-01-00.jpg");

    // Une EDL qui coupe à 10:00:01:05 tombe sur l'image 30.
    let edl = "001  AX V C 00:00:00:00 00:00:01:05 10:00:00:00 10:00:01:05\n002  AX V C 00:00:00:00 00:00:00:20 10:00:01:05 10:00:02:00\n";
    let c = cuts::map_to_film(cuts::parse_edl(edl).unwrap(), &info, "t.edl").unwrap();
    assert_eq!(c.cuts, vec![30]);
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    let _ = std::fs::remove_dir_all(&dir);
}
