//! Exports en lot : images une à une, ou planche contact.
//!
//! Deux modes de production :
//! - direct (images sans overlay) : décodage et encodage entièrement en Rust ;
//! - composition (overlay, planche contact) : l'interface tire chaque image
//!   (`batch_pull`), compose avec le même code que l'aperçu, et renvoie le
//!   résultat (`write_composed` pour une image, `sheet_page` pour une page).

use crate::jobs::{self, run_batch_direct, JobEvent, RawFrame, Throttle};
use crate::runner::{ProcessGroup, CANCELLED};
use crate::state::{lock, AppState, BatchJob, JobKind};
use crate::frames::{palette_of, FrameHeader};
use photogramme_core::batch::{OutSize, PixelFormat};
use photogramme_core::color::{convert_in_place, icc_profile};
use photogramme_core::naming::{film_stem, unique_dir, unique_path};
use photogramme_core::settings::SheetFormat;
use photogramme_core::sheet::{self, JpegPage};
use photogramme_core::{encode_image, export_csv, packet, plan_items, BatchRequest, Chroma, CsvRow, FrameRange, ImageFormat};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    count: usize,
    /// Premières images, pour un aperçu dans l'interface.
    first: Vec<u64>,
}

/// Nombre d'images que produirait un export, sans rien lancer.
#[tauri::command]
pub fn batch_plan(state: State<'_, AppState>, request: BatchRequest, range: Option<FrameRange>) -> Result<BatchPlan, String> {
    let info = state.video()?;
    let items = plan_items(&request, range, info.frame_count, info.fps_num, info.fps_den)?;
    Ok(BatchPlan { count: items.len(), first: items.iter().take(8).map(|i| i.frame).collect() })
}

/// Ce que produit l'export.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchTarget {
    /// Un fichier par image ; `compose` : overlay appliqué par l'interface.
    Stills { compose: bool },
    /// Planche contact ; images décodées à la largeur d'une case.
    #[serde(rename_all = "camelCase")]
    Sheet { cell_width: u32 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStarted {
    job: u64,
    total: usize,
    dir: String,
    /// Taille des images décodées.
    width: u32,
    height: u32,
}

/// Lance un export en lot.
#[tauri::command]
pub async fn batch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: BatchRequest,
    range: Option<FrameRange>,
    target: BatchTarget,
    on_event: Channel<JobEvent>,
) -> Result<BatchStarted, String> {
    let info = state.video()?;
    let settings = state.settings()?;
    let out = PathBuf::from(settings.output_dir.clone().ok_or("Choose an output folder first.")?);
    if !out.is_dir() {
        return Err("The output folder no longer exists.".into());
    }
    let items = plan_items(&request, range, info.frame_count, info.fps_num, info.fps_den)?;
    if matches!(target, BatchTarget::Sheet { .. }) && items.len() > 5_000 {
        return Err(format!("{} frames is too many for a contact sheet (5,000 maximum).", items.len()));
    }
    let spans: HashMap<u32, (u64, u64)> = match &request {
        BatchRequest::Shots { shots, .. } => shots.iter().map(|s| (s.index, (s.start, s.end))).collect(),
        _ => HashMap::new(),
    };
    let (kind, compose, size) = match target {
        BatchTarget::Stills { compose } => (JobKind::Stills, compose, OutSize::full(&info)),
        BatchTarget::Sheet { cell_width } => {
            let (w, h) = photogramme_core::ffargs::fit_width(&info, cell_width.clamp(32, 1920));
            (JobKind::Sheet, true, OutSize { width: w, height: h })
        }
    };
    let dir = if kind == JobKind::Stills && settings.export.subfolder {
        let d = unique_dir(&out, &format!("{}_{}", film_stem(&info.file_name), request.slug()));
        std::fs::create_dir_all(&d).map_err(|e| format!("Cannot create the folder: {e}"))?;
        d
    } else {
        out
    };
    app.asset_protocol_scope()
        .allow_directory(&dir, false)
        .map_err(|e| format!("Folder permission refused: {e}"))?;

    if let Some(old) = lock(&state.batch)?.take() {
        old.group.cancel();
    }
    let group = ProcessGroup::default();
    let id = state.new_id();
    let total = items.len();
    // Mode composition : file d'images que l'interface viendra tirer.
    let (tx, rx) = if compose {
        let (t, r) = tauri::async_runtime::channel::<RawFrame>(jobs::FRAME_QUEUE);
        (Some(t), Some(r))
    } else {
        (None, None)
    };
    let producer_error = Arc::new(Mutex::new(None));
    let job = Arc::new(BatchJob {
        id,
        kind,
        dir: dir.clone(),
        info: info.clone(),
        settings: settings.clone(),
        total,
        width: size.width,
        height: size.height,
        group: group.clone(),
        frames: tauri::async_runtime::Mutex::new(rx),
        producer_error: producer_error.clone(),
        written: Mutex::new(Vec::new()),
        palettes: Mutex::new(HashMap::new()),
        spans,
        cuts: state.cuts(),
        events: on_event.clone(),
        pages: Mutex::new(Vec::new()),
        page_files: Mutex::new(Vec::new()),
    });
    *lock(&state.batch)? = Some(job.clone());

    if let Some(tx) = tx {
        let (app2, info2, err) = (app.clone(), info.clone(), producer_error);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = jobs::produce(app2, group, info2, items, PixelFormat::Rgba, size, tx).await {
                if let Ok(mut x) = err.lock() {
                    *x = Some(e);
                }
            }
        });
    } else {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut th = Throttle::new();
            let mut done = 0u64;
            let res = run_batch_direct(&app2, &job.group, &job.info, &job.settings, items, job.dir.clone(), |w| {
                done += 1;
                if let Ok(mut all) = job.written.lock() {
                    all.push(w.clone());
                }
                let _ = job.events.send(JobEvent::Written { capture: w.capture.clone() });
                if th.ready() || done == job.total as u64 {
                    let _ = job.events.send(JobEvent::Progress { phase: "export", done, total: job.total as u64 });
                }
            })
            .await;
            let event = match res {
                Ok(_) => finish_stills(&job),
                Err(e) if e == CANCELLED => JobEvent::Cancelled,
                Err(e) => JobEvent::Failed { message: e },
            };
            let _ = job.events.send(event);
            if let Some(st) = app2.try_state::<AppState>() {
                if let Ok(mut b) = st.batch.lock() {
                    if b.as_ref().is_some_and(|x| x.id == job.id) {
                        *b = None;
                    }
                }
            }
        });
    }
    Ok(BatchStarted { job: id, total, dir: dir.to_string_lossy().to_string(), width: size.width, height: size.height })
}

/// CSV éventuel et événement de fin d'un export d'images.
fn finish_stills(job: &BatchJob) -> JobEvent {
    let written = job.written.lock().map(|w| w.clone()).unwrap_or_default();
    let mut csv = None;
    if job.settings.export.csv && !written.is_empty() {
        let rows: Vec<CsvRow> = written
            .iter()
            .map(|w| CsvRow {
                capture: Some(w.capture.clone()),
                span: w.capture.shot.and_then(|s| job.spans.get(&s).copied()),
                clip: job.cuts.as_ref().and_then(|c| c.name_at(w.capture.frame).map(str::to_string)),
                palette: w.palette.clone(),
            })
            .collect();
        let path = unique_path(&job.dir, &format!("{}_export.csv", film_stem(&job.info.file_name)));
        if photogramme_core::capture::write_new_file(&path, export_csv(&job.info, &rows).as_bytes()).is_ok() {
            csv = Some(path.to_string_lossy().to_string());
        }
    }
    JobEvent::Done { written: written.len(), dir: job.dir.to_string_lossy().to_string(), csv, file: None }
}

pub fn current_job(state: &AppState, id: u64) -> Result<Arc<BatchJob>, String> {
    lock(&state.batch)?.clone().filter(|j| j.id == id).ok_or_else(|| CANCELLED.to_string())
}

/// Mode composition : image suivante (paquet RVBA + palette), ou corps vide
/// quand tout a été décodé.
#[tauri::command]
pub async fn batch_pull(state: State<'_, AppState>, job: u64) -> Result<Response, String> {
    let j = current_job(&state, job)?;
    let next = {
        let mut guard = j.frames.lock().await;
        match guard.as_mut() {
            Some(rx) => rx.recv().await,
            None => None,
        }
    };
    let Some(f) = next else {
        if let Some(e) = j.producer_error.lock().ok().and_then(|e| e.clone()) {
            return Err(e);
        }
        if j.group.is_cancelled() {
            return Err(CANCELLED.into());
        }
        return Ok(Response::new(Vec::new()));
    };
    let j2 = j.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let s = &j2.settings;
        let mut px = f.pixels;
        convert_in_place(&mut px, 4, s.export.color);
        let (w, h) = (j2.width, j2.height);
        let want_palette = match j2.kind {
            JobKind::Sheet => s.sheet.show_palette,
            JobKind::Stills => s.overlay.palette.enabled || s.export.csv_palette,
        };
        let palette = if want_palette { palette_of(s, &px, w, h, 4) } else { Vec::new() };
        if j2.kind == JobKind::Stills && s.export.csv_palette {
            if let Ok(mut p) = j2.palettes.lock() {
                p.insert(f.item.frame, palette.iter().map(|sw| sw.hex.clone()).collect());
            }
        }
        let header = FrameHeader {
            frame: f.item.frame,
            timecode: j2.info.tc(f.item.frame),
            width: w,
            height: h,
            palette,
            shot: f.item.shot,
            clip: j2.cuts.as_ref().and_then(|c| c.name_at(f.item.frame).map(str::to_string)),
            job: Some(j2.id),
            total: Some(j2.total),
        };
        packet::encode(&header, &px)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageHeader {
    job: u64,
    width: u32,
    height: u32,
}

/// Planche contact : une page composée par l'interface (paquet [en-tête][RVBA]).
#[tauri::command]
pub async fn sheet_page(state: State<'_, AppState>, request: Request<'_>) -> Result<usize, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Binary body expected.".into());
    };
    let (h, _) = packet::decode::<PageHeader>(body)?;
    let j = current_job(&state, h.job)?;
    if j.kind != JobKind::Sheet {
        return Err("This export is not a contact sheet.".into());
    }
    if h.width == 0 || h.height == 0 || h.width > 16_384 || h.height > 16_384 {
        return Err("Invalid page size.".into());
    }
    let body = body.clone();
    let j2 = j.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (h, rgba) = packet::decode::<PageHeader>(&body)?;
        if rgba.len() != h.width as usize * h.height as usize * 4 {
            return Err("Incomplete page.".to_string());
        }
        let s = &j2.settings;
        let icc = icc_profile(s.export.color);
        match s.sheet.format {
            SheetFormat::Pdf => {
                let mut pages = lock(&j2.pages)?;
                if pages.len() >= sheet::MAX_PAGES {
                    return Err(format!("A contact sheet is limited to {} pages.", sheet::MAX_PAGES));
                }
                let jpeg = encode_image(rgba, h.width, h.height, true, ImageFormat::Jpeg, 90, Chroma::C420, None)?;
                pages.push(JpegPage { jpeg, width: h.width, height: h.height });
                Ok(pages.len())
            }
            SheetFormat::Jpeg | SheetFormat::Png => {
                let fmt = if s.sheet.format == SheetFormat::Png { ImageFormat::Png } else { ImageFormat::Jpeg };
                let data = encode_image(rgba, h.width, h.height, true, fmt, 92, Chroma::C444, icc.as_deref())?;
                let mut files = lock(&j2.page_files)?;
                let n = files.len() + 1;
                let path = unique_path(
                    &j2.dir,
                    &format!("{}_contact-sheet_p{n:02}.{}", film_stem(&j2.info.file_name), fmt.extension()),
                );
                photogramme_core::capture::write_new_file(&path, &data)?;
                files.push(path.to_string_lossy().to_string());
                Ok(n)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mode composition : fin normale (CSV ou PDF, événement « done »).
#[tauri::command]
pub async fn batch_finish(state: State<'_, AppState>, job: u64) -> Result<(), String> {
    let j = current_job(&state, job)?;
    let j2 = j.clone();
    let ev = tauri::async_runtime::spawn_blocking(move || -> Result<JobEvent, String> {
        if j2.kind == JobKind::Stills {
            return Ok(finish_stills(&j2));
        }
        let dir = j2.dir.to_string_lossy().to_string();
        if j2.settings.sheet.format == SheetFormat::Pdf {
            let pages = std::mem::take(&mut *lock(&j2.pages)?);
            let title = format!("{} - contact sheet", film_stem(&j2.info.file_name));
            let doc = sheet::pdf(&pages, j2.settings.sheet.page_mm_landscaped(), &title)?;
            let path = unique_path(&j2.dir, &format!("{}_contact-sheet.pdf", film_stem(&j2.info.file_name)));
            photogramme_core::capture::write_new_file(&path, &doc)?;
            Ok(JobEvent::Done { written: pages.len(), dir, csv: None, file: Some(path.to_string_lossy().to_string()) })
        } else {
            let files = lock(&j2.page_files)?.clone();
            Ok(JobEvent::Done { written: files.len(), dir, csv: None, file: files.first().cloned() })
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let ev = match ev {
        Ok(e) => e,
        Err(message) => JobEvent::Failed { message },
    };
    let _ = j.events.send(ev);
    *lock(&state.batch)? = None;
    Ok(())
}

#[tauri::command]
pub fn batch_cancel(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(j) = lock(&state.batch)?.take() {
        j.group.cancel();
        let _ = j.events.send(JobEvent::Cancelled);
    }
    Ok(())
}
