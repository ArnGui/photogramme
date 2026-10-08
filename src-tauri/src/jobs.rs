//! Travaux longs : analyse du film et export en lot.
//! Fonctions génériques sur le runtime Tauri pour être testées avec le
//! runtime factice (`tauri::test`) et un vrai FFmpeg.

use crate::runner::{failure_message, spawn_frames, FrameMsg, ProcessGroup, CANCELLED};
use photogramme_core::analysis::{Analysis, Analyzer, Decoder};
use photogramme_core::batch::{frame_len, group_args, group_frames, DecodeGroup, OutSize, PixelFormat};
use photogramme_core::color::convert_in_place;
use photogramme_core::settings::DecoderPref;
use photogramme_core::{analysis_args, capture_converted, dominant_colors, BatchItem, CaptureResult, Settings, VideoInfo};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::{channel, Sender};
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::{Command, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Nombre de FFmpeg en parallèle pendant un export en lot. Chacun décode
/// déjà sur plusieurs cœurs ; deux suffisent à masquer le temps de seek.
const DECODE_WORKERS: usize = 2;
/// Encodages JPEG simultanés (export sans overlay).
const ENCODE_WORKERS: usize = 3;
/// Images décodées en attente : borne la mémoire (3 × 25 Mo en 4K).
pub const FRAME_QUEUE: usize = 3;

/// Commande FFmpeg / ffprobe. En test : exécutable du PATH ou de la
/// variable PHOTOGRAMME_FFMPEG ; en vrai : le binaire embarqué (sidecar).
pub fn tool<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<Command, String> {
    #[cfg(test)]
    {
        let exe = std::env::var(format!("PHOTOGRAMME_{}", name.to_uppercase())).unwrap_or_else(|_| name.to_string());
        Ok(app.shell().command(exe))
    }
    #[cfg(not(test))]
    {
        app.shell().sidecar(name).map_err(|e| format!("{name} not found in the app: {e}"))
    }
}

/// Événements envoyés à l'interface pendant un travail long.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobEvent {
    Progress { phase: &'static str, done: u64, total: u64 },
    Written { capture: CaptureResult },
    /// `file` : planche contact (PDF ou première page).
    Done { written: usize, dir: String, csv: Option<String>, file: Option<String> },
    Failed { message: String },
    Cancelled,
}

/// Limite les messages de progression à 10 par seconde.
pub struct Throttle(Option<Instant>);
impl Throttle {
    pub fn new() -> Self {
        Self(None)
    }
    pub fn ready(&mut self) -> bool {
        let now = Instant::now();
        match self.0 {
            Some(t) if now - t < Duration::from_millis(100) => false,
            _ => {
                self.0 = Some(now);
                true
            }
        }
    }
}

/// Ordre d'essai des décodeurs et note éventuelle pour l'interface.
pub fn decoder_plan(pref: DecoderPref, info: &VideoInfo) -> (Vec<Decoder>, Option<String>) {
    match pref {
        DecoderPref::Cpu => (vec![Decoder::Cpu], None),
        DecoderPref::Gpu => (vec![Decoder::Gpu], None),
        DecoderPref::Auto if info.nvdec_compatible => (vec![Decoder::Gpu, Decoder::Cpu], None),
        DecoderPref::Auto => (
            vec![Decoder::Cpu],
            Some(format!(
                "{} {}: {} cannot decode this file, analysis ran on the CPU.",
                info.codec,
                info.pix_fmt,
                photogramme_core::GPU_DECODER
            )),
        ),
    }
}

/// Une passe d'analyse complète avec un décodeur donné.
async fn analysis_pass<R: Runtime>(
    app: &AppHandle<R>,
    info: &VideoInfo,
    decoder: Decoder,
    group: &ProcessGroup,
    progress: &mut impl FnMut(u64, u64, Decoder),
) -> Result<Analysis, String> {
    let (mut rx, pid) = group.spawn(tool(app, "ffmpeg")?.args(analysis_args(info, decoder)), "ffmpeg")?;
    let mut an = Analyzer::new(info, decoder);
    let (mut code, mut err) = (None, None);
    let mut th = Throttle::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(c) => {
                an.push_stdout(&c);
                if th.ready() {
                    progress(an.frames(), info.frame_count, decoder);
                }
            }
            CommandEvent::Stderr(c) => an.push_stderr(&c),
            CommandEvent::Terminated(p) => code = p.code,
            CommandEvent::Error(e) => err = Some(e),
            _ => {}
        }
    }
    group.forget(pid);
    if group.is_cancelled() {
        return Err(CANCELLED.into());
    }
    if code != Some(0) {
        return Err(failure_message("ffmpeg", &an.error_text(), code, err));
    }
    let a = an.finish();
    if a.frames == 0 {
        return Err("No frame could be decoded.".into());
    }
    progress(a.frames, a.frames, decoder);
    Ok(a)
}

/// Analyse le film : GPU d'abord si possible, repli automatique sur le
/// processeur. Renvoie l'analyse et une note à afficher (repli, etc.).
pub async fn run_analysis<R: Runtime>(
    app: &AppHandle<R>,
    info: &VideoInfo,
    pref: DecoderPref,
    group: &ProcessGroup,
    mut progress: impl FnMut(u64, u64, Decoder),
) -> Result<(Analysis, Option<String>), String> {
    let (order, mut note) = decoder_plan(pref, info);
    let mut last_err = String::new();
    for (i, d) in order.iter().enumerate() {
        match analysis_pass(app, info, *d, group, &mut progress).await {
            Ok(a) => return Ok((a, note)),
            Err(e) if e == CANCELLED => return Err(e),
            Err(e) => {
                if i + 1 < order.len() {
                    // La ligne qui nomme le GPU dit la vraie cause (« Cannot load nvcuda.dll »).
                    let first = e
                        .lines()
                        .find(|l| photogramme_core::analysis::looks_like_gpu_failure(l))
                        .or_else(|| e.lines().last())
                        .unwrap_or("")
                        .trim()
                        .trim_start_matches("ffmpeg: ")
                        .to_string();
                    // « [CUDA @ 0x55…] Could not… » → « Could not… »
                    let first = match (first.starts_with('['), first.find("] ")) {
                        (true, Some(i)) => first[i + 2..].to_string(),
                        _ => first,
                    };
                    note = Some(format!("GPU decoding failed ({first}). Analysis ran on the CPU."));
                }
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// Image décodée pendant un export en lot.
pub struct RawFrame {
    pub item: BatchItem,
    pub pixels: Vec<u8>,
}

/// Fichier écrit par l'export en lot, avec la palette demandée pour le CSV.
#[derive(Debug, Clone)]
pub struct Written {
    pub capture: CaptureResult,
    pub palette: Option<Vec<String>>,
}

/// Décode un groupe et envoie ses images une par une (avec contre-pression).
#[allow(clippy::too_many_arguments)]
async fn decode_group<R: Runtime>(
    app: &AppHandle<R>,
    group: &ProcessGroup,
    info: &VideoInfo,
    g: &DecodeGroup,
    fmt: PixelFormat,
    size: OutSize,
    shots: &HashMap<u64, Option<u32>>,
    tx: &Sender<RawFrame>,
) -> Result<(), String> {
    let cmd = tool(app, "ffmpeg")?.args(group_args(info, g, fmt, size));
    let (mut rx, pid) = spawn_frames(group, cmd, "ffmpeg", frame_len(size, fmt))?;
    let mut frames = g.frames();
    let mut sent = 0usize;
    let mut receiver_gone = false;
    let mut end = None;
    while let Some(msg) = rx.recv().await {
        match msg {
            FrameMsg::Frame(pixels) => {
                let (Some(frame), false) = (frames.next(), receiver_gone) else { continue };
                let item = BatchItem { frame, shot: shots.get(&frame).copied().flatten() };
                if tx.send(RawFrame { item, pixels }).await.is_err() {
                    // Plus personne n'attend ces images : on arrête FFmpeg.
                    receiver_gone = true;
                    group.kill(pid);
                } else {
                    sent += 1;
                }
            }
            FrameMsg::Done { code, stderr, leftover } => end = Some((code, stderr, leftover)),
        }
    }
    group.forget(pid);
    if group.is_cancelled() || receiver_gone {
        return Err(CANCELLED.into());
    }
    let (code, stderr, leftover) = end.unwrap_or((None, String::new(), 0));
    if code != Some(0) {
        return Err(failure_message("ffmpeg", &stderr, code, None));
    }
    if sent != g.offsets.len() || leftover != 0 {
        return Err(format!(
            "Only {sent} of {} frames decoded near {}: end of film or damaged file?",
            g.offsets.len(),
            info.tc(g.first)
        ));
    }
    Ok(())
}

/// Décode toutes les images demandées, `DECODE_WORKERS` FFmpeg à la fois,
/// à la taille `size` (taille d'export, ou réduite pour une planche contact).
/// À la première erreur, tout le groupe est arrêté et l'erreur renvoyée.
pub async fn produce<R: Runtime>(
    app: AppHandle<R>,
    group: ProcessGroup,
    info: VideoInfo,
    items: Vec<BatchItem>,
    fmt: PixelFormat,
    size: OutSize,
    tx: Sender<RawFrame>,
) -> Result<(), String> {
    let shots: Arc<HashMap<u64, Option<u32>>> = Arc::new(items.iter().map(|i| (i.frame, i.shot)).collect());
    let frames: Vec<u64> = items.iter().map(|i| i.frame).collect();
    let queue = Arc::new(Mutex::new(group_frames(&frames, info.fps).into_iter().collect::<VecDeque<_>>()));
    let first_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let info = Arc::new(info);

    let mut handles = Vec::new();
    for _ in 0..DECODE_WORKERS {
        let (app, group, info, shots, tx, queue, first_error) =
            (app.clone(), group.clone(), info.clone(), shots.clone(), tx.clone(), queue.clone(), first_error.clone());
        handles.push(tauri::async_runtime::spawn(async move {
            loop {
                let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                let Some(g) = next else { break };
                if let Err(e) = decode_group(&app, &group, &info, &g, fmt, size, &shots, &tx).await {
                    if let Ok(mut fe) = first_error.lock() {
                        if fe.is_none() && e != CANCELLED {
                            *fe = Some(e);
                        }
                    }
                    group.cancel();
                    break;
                }
            }
        }));
    }
    drop(tx);
    for h in handles {
        let _ = h.await;
    }
    let err = first_error.lock().ok().and_then(|mut e| e.take());
    match err {
        Some(e) => Err(e),
        None if group.is_cancelled() => Err(CANCELLED.into()),
        None => Ok(()),
    }
}

/// Export en lot sans overlay : décodage + encodage en parallèle.
/// `on_written` est appelé après chaque fichier écrit.
pub async fn run_batch_direct<R: Runtime>(
    app: &AppHandle<R>,
    group: &ProcessGroup,
    info: &VideoInfo,
    settings: &Settings,
    items: Vec<BatchItem>,
    dir: PathBuf,
    mut on_written: impl FnMut(&Written),
) -> Result<Vec<Written>, String> {
    let (tx, mut rx) = channel::<RawFrame>(FRAME_QUEUE);
    let producer = tauri::async_runtime::spawn(produce(
        app.clone(),
        group.clone(),
        info.clone(),
        items,
        PixelFormat::Rgb24,
        OutSize::full(info),
        tx,
    ));
    let info = Arc::new(info.clone());
    let settings = Arc::new(settings.clone());
    let dir = Arc::new(dir);

    let mut inflight = VecDeque::new();
    let mut written = Vec::new();
    let mut write_err: Option<String> = None;

    let mut settle = |r: Result<Result<Written, String>, tauri::Error>,
                      written: &mut Vec<Written>,
                      write_err: &mut Option<String>| match r {
        Ok(Ok(c)) => {
            on_written(&c);
            written.push(c);
        }
        Ok(Err(e)) => {
            if write_err.is_none() {
                *write_err = Some(e);
                group.cancel();
            }
        }
        Err(e) => {
            if write_err.is_none() {
                *write_err = Some(format!("Encoding task interrupted: {e}"));
                group.cancel();
            }
        }
    };

    while let Some(f) = rx.recv().await {
        if write_err.is_some() {
            continue; // on vide la file pendant que les FFmpeg s'arrêtent
        }
        let (info, settings, dir) = (info.clone(), settings.clone(), dir.clone());
        inflight.push_back(tauri::async_runtime::spawn_blocking(move || {
            let mut px = f.pixels;
            convert_in_place(&mut px, 3, settings.export.color);
            // Palette des pixels réellement écrits (après conversion éventuelle).
            let palette = settings.export.csv_palette.then(|| {
                dominant_colors(&px, info.out_width, info.out_height, 3, &settings.palette)
                    .into_iter()
                    .map(|s| s.hex)
                    .collect::<Vec<_>>()
            });
            let capture = capture_converted(&info, f.item.frame, f.item.shot, &px, &settings, &dir)?;
            Ok(Written { capture, palette })
        }));
        while inflight.len() >= ENCODE_WORKERS {
            let r = inflight.pop_front().unwrap().await;
            settle(r, &mut written, &mut write_err);
        }
    }
    while let Some(h) = inflight.pop_front() {
        let r = h.await;
        settle(r, &mut written, &mut write_err);
    }
    let produced = producer.await.map_err(|e| format!("Decoding task interrupted: {e}"))?;
    if let Some(e) = write_err {
        return Err(e);
    }
    produced?;
    Ok(written)
}
