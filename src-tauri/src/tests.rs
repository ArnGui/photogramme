//! Tests de la couche Tauri : vrai plugin shell, runtime factice, vrai FFmpeg.
//! Ignorés si `ffmpeg` est introuvable (PATH ou PHOTOGRAMME_FFMPEG).

use crate::jobs::{decoder_plan, produce, run_analysis, run_batch_direct};
use crate::runner::{run_raw, ProcessGroup, RawOutput, CANCELLED};
use crate::shots_cmd::thumb_response;
use crate::state::StoredAnalysis;
use photogramme_core::analysis::{Analysis, Decoder};
use photogramme_core::batch::{frame_len, OutSize, PixelFormat};
use photogramme_core::settings::DecoderPref;
use photogramme_core::{
    capture_args_fmt, parse_probe, plan_items, probe_args, shots, BatchItem, BatchRequest, Pick, Settings, ShotSpan, VideoInfo,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::process::Command as StdCommand;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

fn ffmpeg_exe() -> String {
    std::env::var("PHOTOGRAMME_FFMPEG").unwrap_or_else(|_| "ffmpeg".into())
}
fn ffprobe_exe() -> String {
    std::env::var("PHOTOGRAMME_FFPROBE").unwrap_or_else(|_| "ffprobe".into())
}

fn have_ffmpeg() -> bool {
    let ok = StdCommand::new(ffmpeg_exe()).arg("-version").output().is_ok()
        && StdCommand::new(ffprobe_exe()).arg("-version").output().is_ok();
    if !ok {
        eprintln!("ffmpeg absent : test ignoré");
    }
    ok
}

fn app() -> tauri::App<MockRuntime> {
    mock_builder()
        .plugin(tauri_plugin_shell::init())
        .build(mock_context(noop_assets()))
        .unwrap()
}

fn workdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("photogramme-tauri-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Vidéo H.264 de test (libx264 si disponible, sinon libopenh264 du build LGPL).
fn make_video(filter: &str, out: &Path) -> VideoInfo {
    let x264 = StdCommand::new(ffmpeg_exe())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("libx264"))
        .unwrap_or(false);
    let codec: &[&str] = if x264 { &["-c:v", "libx264", "-g", "24", "-bf", "2"] } else { &["-c:v", "libopenh264", "-b:v", "6M", "-g", "24"] };
    let st = StdCommand::new(ffmpeg_exe())
        // -nostdin + entrée vide : sous Windows, un FFmpeg branché sur la console
        // peut rester bloqué quand plusieurs tests tournent en parallèle.
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", filter])
        .stdin(std::process::Stdio::null())
        .args(codec)
        .args(["-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709"])
        .arg(out)
        .status()
        .unwrap();
    assert!(st.success());
    let p = StdCommand::new(ffprobe_exe()).args(probe_args(out.to_str().unwrap())).output().unwrap();
    parse_probe(&String::from_utf8_lossy(&p.stdout), out.to_str().unwrap()).unwrap()
}

const CUTS: &str = "testsrc2=s=320x180:r=24:d=2[a];smptehdbars=s=320x180:r=24:d=1[b];\
                    mandelbrot=s=320x180:r=24,trim=duration=2,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1";

#[test]
fn les_morceaux_sont_concatenes_sans_ajout() {
    let mut out = RawOutput::default();
    let total = 3840 * 2160 * 3;
    let mut sent = 0;
    while sent < total {
        let n = (total - sent).min(8192);
        out.push(CommandEvent::Stdout(vec![0x0A; n]));
        sent += n;
    }
    out.push(CommandEvent::Terminated(TerminatedPayload { code: Some(0), signal: None }));
    assert_eq!(out.stdout.len(), total);
    assert_eq!(out.code, Some(0));
}

/// Reproduit le bug d'origine avec le vrai plugin et un vrai FFmpeg :
/// une image UHD en RVB brut doit faire exactement 24 883 200 octets.
#[test]
fn image_4k_intacte_via_le_plugin_shell() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let args = [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=25",
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ];
    let expected = 3840 * 2160 * 3;
    let cmd = app.shell().command(ffmpeg_exe()).args(args);
    let raw = tauri::async_runtime::block_on(run_raw(cmd, "ffmpeg")).unwrap();
    assert_eq!(raw.len(), expected);
    // Diagnostic : l'ancienne méthode `output()` ajoute un octet par morceau.
    let old = tauri::async_runtime::block_on(app.shell().command(ffmpeg_exe()).args(args).set_raw_out(true).output()).unwrap();
    assert!(old.stdout.len() > expected, "output() ne corrompt plus : {}", old.stdout.len());
}

#[test]
fn analyse_par_le_plugin_avec_repli_cpu() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("analyse");
    let info = make_video(CUTS, &dir.join("plans.mp4"));
    assert!(info.nvdec_compatible);
    let group = ProcessGroup::default();
    let mut events = 0;
    let (a, note) = tauri::async_runtime::block_on(run_analysis(app.handle(), &info, DecoderPref::Auto, &group, |_, _, _| events += 1)).unwrap();
    assert!(events >= 1);
    let p = shots::detect(&a.scores, a.frames, 10.0, 12);
    assert_eq!(p.iter().map(|s| (s.start, s.end)).collect::<Vec<_>>(), vec![(0, 48), (48, 72), (72, 120)]);
    // Sans carte NVIDIA ici : repli CPU attendu, et signalé.
    if a.decoder == Decoder::Cpu {
        let n = note.expect("le repli doit être signalé");
        assert!(n.starts_with("GPU decoding failed"), "{n}");
        eprintln!("note : {n}");
    }
    // Choix CPU explicite : aucun essai GPU, aucune note.
    let (a2, note2) = tauri::async_runtime::block_on(run_analysis(app.handle(), &info, DecoderPref::Cpu, &group, |_, _, _| {})).unwrap();
    assert_eq!((a2.decoder, note2), (Decoder::Cpu, None));
    assert_eq!(a2.scores, a.scores, "mêmes scores en CPU");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn plan_des_decodeurs() {
    let mut info = parse_probe(
        r#"{"streams":[{"codec_type":"video","codec_name":"h264","profile":"High 4:2:2","pix_fmt":"yuv422p",
            "width":4,"height":2,"avg_frame_rate":"25/1","r_frame_rate":"25/1","nb_frames":"100","color_space":"bt709"}],
            "format":{"duration":"4"}}"#,
        "a.mp4",
    )
    .unwrap();
    let (order, note) = decoder_plan(DecoderPref::Auto, &info);
    assert_eq!(order, vec![Decoder::Cpu]);
    assert!(note.unwrap().contains(&format!("{} cannot decode", photogramme_core::GPU_DECODER)));
    info.nvdec_compatible = true;
    assert_eq!(decoder_plan(DecoderPref::Auto, &info).0, vec![Decoder::Gpu, Decoder::Cpu]);
    assert_eq!(decoder_plan(DecoderPref::Gpu, &info).0, vec![Decoder::Gpu], "GPU forcé : pas de repli silencieux");
}

#[test]
fn annulation_de_l_analyse() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("annule");
    let info = make_video("testsrc2=s=640x360:r=25:d=120", &dir.join("long.mp4"));
    let group = ProcessGroup::default();
    let g2 = group.clone();
    let t0 = std::time::Instant::now();
    let res = tauri::async_runtime::block_on(run_analysis(app.handle(), &info, DecoderPref::Cpu, &group, move |done, _, _| {
        if done > 50 {
            g2.cancel();
        }
    }));
    assert_eq!(res.err().as_deref(), Some(CANCELLED));
    assert!(t0.elapsed().as_secs_f64() < 10.0, "annulation trop lente");
    assert_eq!(group.running(), 0, "aucun FFmpeg orphelin");
    let _ = std::fs::remove_dir_all(&dir);
}

fn ramp(dir: &Path) -> VideoInfo {
    make_video("nullsrc=s=64x48:r=24000/1001:d=3.5,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128", &dir.join("rampe.mp4"))
}

#[test]
fn export_en_lot_direct() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("lot");
    let info = ramp(&dir);
    let out = dir.join("sortie");
    std::fs::create_dir_all(&out).unwrap();
    let req = BatchRequest::Shots {
        shots: vec![ShotSpan { index: 1, start: 0, end: 30 }, ShotSpan { index: 2, start: 30, end: 84 }],
        pick: Pick::Spread { count: 3 },
    };
    let items = plan_items(&req, None, info.frame_count, info.fps_num, info.fps_den).unwrap();
    assert_eq!(items.len(), 6);
    let mut seen = 0;
    let res = tauri::async_runtime::block_on(run_batch_direct(
        app.handle(),
        &ProcessGroup::default(),
        &info,
        &Settings::default(),
        items.clone(),
        out.clone(),
        |_| seen += 1,
    ))
    .unwrap();
    assert_eq!((res.len(), seen), (6, 6));
    let mut names: Vec<String> = res.iter().map(|w| w.capture.file_name.clone()).collect();
    names.sort();
    assert_eq!(names[0], "rampe_P0001_00-00-00-05.jpg");
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 6);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn composition_rvba_identique_a_la_capture() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("rvba");
    let info = ramp(&dir);
    let items: Vec<BatchItem> = [5u64, 33, 80].iter().map(|&frame| BatchItem { frame, shot: None }).collect();
    let (tx, mut rx) = tauri::async_runtime::channel(2);
    let group = ProcessGroup::default();
    let mut got = Vec::new();
    tauri::async_runtime::block_on(async {
        let p = tauri::async_runtime::spawn(produce(app.handle().clone(), group.clone(), info.clone(), items, PixelFormat::Rgba, OutSize::full(&info), tx));
        while let Some(f) = rx.recv().await {
            got.push(f);
        }
        p.await.unwrap().unwrap();
    });
    got.sort_by_key(|f| f.item.frame);
    assert_eq!(got.len(), 3);
    for f in &got {
        assert_eq!(f.pixels.len(), frame_len(OutSize::full(&info), PixelFormat::Rgba));
        let one = StdCommand::new(ffmpeg_exe()).args(capture_args_fmt(&info, f.item.frame, "rgba")).output().unwrap();
        assert!(one.stdout == f.pixels, "image {} différente de la capture à l'unité", f.item.frame);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Planche contact : images décodées à la taille d'une case, mêmes images.
#[test]
fn decodage_a_la_taille_d_une_case() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("case");
    let info = make_video(CUTS, &dir.join("plans.mp4"));
    let size = OutSize { width: 96, height: 54 };
    let items: Vec<BatchItem> = [10u64, 60, 100].iter().map(|&frame| BatchItem { frame, shot: Some(1) }).collect();
    let (tx, mut rx) = tauri::async_runtime::channel(2);
    let mut got = Vec::new();
    tauri::async_runtime::block_on(async {
        let p = tauri::async_runtime::spawn(produce(app.handle().clone(), ProcessGroup::default(), info.clone(), items, PixelFormat::Rgba, size, tx));
        while let Some(f) = rx.recv().await {
            got.push(f);
        }
        p.await.unwrap().unwrap();
    });
    assert_eq!(got.len(), 3);
    for f in &got {
        assert_eq!(f.pixels.len(), 96 * 54 * 4);
        let one = StdCommand::new(ffmpeg_exe())
            .args(photogramme_core::capture_args_sized(&info, f.item.frame, "rgba", 96, 54))
            .output()
            .unwrap();
        assert!(one.stdout == f.pixels, "case {} différente de la capture réduite", f.item.frame);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn export_png_avec_palette_dans_le_csv() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("png");
    let info = make_video(CUTS, &dir.join("plans.mp4"));
    let mut s = Settings::default();
    s.export.format = photogramme_core::ImageFormat::Png;
    s.export.csv_palette = true;
    s.export.color = photogramme_core::ColorProfile::Rec709;
    let items = vec![BatchItem { frame: 10, shot: None }, BatchItem { frame: 60, shot: None }];
    let res = tauri::async_runtime::block_on(run_batch_direct(app.handle(), &ProcessGroup::default(), &info, &s, items, dir.clone(), |_| {}))
        .unwrap();
    assert_eq!(res.len(), 2);
    for w in &res {
        assert!(w.capture.file_name.ends_with(".png"));
        assert!(!w.palette.as_ref().unwrap().is_empty(), "palette calculée pour le CSV");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn image_au_dela_de_la_fin_signalee() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let dir = workdir("fin");
    let info = ramp(&dir);
    let items = vec![BatchItem { frame: 10, shot: None }, BatchItem { frame: 500, shot: None }];
    let res = tauri::async_runtime::block_on(run_batch_direct(
        app.handle(),
        &ProcessGroup::default(),
        &info,
        &Settings::default(),
        items,
        dir.clone(),
        |_| {},
    ));
    let err = res.unwrap_err();
    assert!(err.contains("frames decoded near"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn protocole_des_vignettes() {
    let mut thumbs = std::collections::BTreeMap::new();
    thumbs.insert(24u64, vec![0xFF, 0xD8, 1]);
    let a = Arc::new(StoredAnalysis {
        id: 7,
        path: "a.mp4".into(),
        data: Analysis {
            frames: 48,
            scores: vec![0.0; 48],
            columns: vec![0; 48 * 3],
            geometry: photogramme_core::analysis::Geometry { analysis_w: 2, analysis_h: 2, thumb_w: 2, thumb_h: 1 },
            thumbs,
            decoder: Decoder::Cpu,
        },
    });
    let ok = thumb_response(Some(a.clone()), "/7-24");
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers()["Content-Type"], "image/jpeg");
    assert_eq!(ok.body(), &vec![0xFF, 0xD8, 1]);
    for bad in ["/6-24", "/7-25", "/7-24-1", "/7/24", "/7-../../etc", "", "/x-y"] {
        assert_eq!(thumb_response(Some(a.clone()), bad).status(), 404, "{bad}");
    }
    assert_eq!(thumb_response(None, "/7-24").status(), 404);
    // Vignette la plus proche : n'importe quelle image renvoie celle qui existe.
    for near in ["/7-n0", "/7-n24", "/7-n9999"] {
        let r = thumb_response(Some(a.clone()), near);
        assert_eq!(r.status(), 200, "{near}");
        assert_eq!(r.body(), &vec![0xFF, 0xD8, 1]);
    }
    for bad in ["/6-n24", "/7-nx", "/7-n", "/7-nn24", "/7-n-24"] {
        assert_eq!(thumb_response(Some(a.clone()), bad).status(), 404, "{bad}");
    }
}

/// Débit du plugin shell (morceaux de 8 Kio) sur des images 1080p : mesure.
#[test]
#[ignore]
fn debit_du_plugin_shell_1080p() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let cmd = app.shell().command(ffmpeg_exe()).args([
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=1920x1080:r=25:d=8",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    let t0 = std::time::Instant::now();
    let raw = tauri::async_runtime::block_on(run_raw(cmd, "ffmpeg")).unwrap();
    let s = t0.elapsed().as_secs_f64();
    eprintln!("{} Mo en {:.2} s = {:.0} Mo/s ({:.0} images 1080p/s)", raw.len() / 1_000_000, s, raw.len() as f64 / 1e6 / s, 200.0 / s);
}

/// Même mesure par la lecture directe image par image (export en lot).
#[test]
#[ignore]
fn debit_lecture_directe_1080p() {
    if !have_ffmpeg() {
        return;
    }
    let app = app();
    let cmd = app.shell().command(ffmpeg_exe()).args([
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=1920x1080:r=25:d=8",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    let t0 = std::time::Instant::now();
    let group = ProcessGroup::default();
    let (mut rx, _) = crate::runner::spawn_frames(&group, cmd, "ffmpeg", 1920 * 1080 * 3).unwrap();
    let mut n = 0;
    let mut code = None;
    tauri::async_runtime::block_on(async {
        while let Some(m) = rx.recv().await {
            match m {
                crate::runner::FrameMsg::Frame(_) => n += 1,
                crate::runner::FrameMsg::Done { code: c, .. } => code = c,
            }
        }
    });
    let s = t0.elapsed().as_secs_f64();
    assert_eq!((n, code), (200, Some(0)));
    eprintln!("lecture directe : {:.0} Mo/s ({:.0} images 1080p/s)", 200.0 * 6.2208 / s, 200.0 / s);
}

#[test]
fn annulation_d_un_export_en_lot() {
    if !have_ffmpeg() {
        return;
    }
    // Le test tourne dans un fil à part : s'il reste bloqué, il échoue au bout
    // de deux minutes avec un message clair au lieu de bloquer toute la suite.
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let app = app();
        let dir = workdir("annule-lot");
        let info = make_video("testsrc2=s=640x360:r=25:d=60", &dir.join("long.mp4"));
        let items: Vec<BatchItem> = (0..1500).step_by(2).map(|frame| BatchItem { frame, shot: None }).collect();
        let group = ProcessGroup::default();
        let g2 = group.clone();
        let mut n = 0;
        let res = tauri::async_runtime::block_on(run_batch_direct(app.handle(), &group, &info, &Settings::default(), items, dir.clone(), |_| {
            n += 1;
            if n == 10 {
                g2.cancel();
            }
        }));
        let running = group.running();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = done_tx.send((res.err(), running));
    });
    let (err, running) = done_rx
        .recv_timeout(std::time::Duration::from_secs(120))
        .expect("l'annulation d'un export en lot reste bloquée (plus de 2 minutes)");
    assert_eq!(err.as_deref(), Some(CANCELLED));
    assert_eq!(running, 0, "aucun FFmpeg orphelin");
}


#[test]
fn film_passe_au_lancement() {
    let dir = workdir("argv");
    let film = dir.join("Mon film.MP4");
    std::fs::write(&film, b"x").unwrap();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let f = film.to_string_lossy().to_string();
    assert_eq!(crate::film::startup_film(s(&["photogramme", "-psn_0_1234", &f])), Some(film.clone()));
    // Le programme lui-même n'est jamais pris pour un film.
    assert_eq!(crate::film::startup_film(s(&[&f])), None);
    assert_eq!(crate::film::startup_film(s(&["photogramme", "notes.txt"])), None);
    assert_eq!(crate::film::startup_film(s(&["photogramme", "absent.mp4"])), None, "fichier inexistant");
    let _ = std::fs::remove_dir_all(&dir);
}
