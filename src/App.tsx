import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, CANCELLED, errorMessage } from "./api";
import { composeToPixels, loadFonts, makeTokens, render } from "./compose";
import { useDebounced, usePlayer } from "./hooks";
import { parseSession, snapshot } from "./session";
import { applyAppearance, effectiveTheme } from "./theme";
import { buildShots, cutAt, mergeWithNext, selectedSpans, shotAt } from "./shotlist";
import { drawPage, expandTitle, sheetLayout } from "./sheet";
import type { SheetCell, SheetLayout } from "./sheet";
import { checkSync } from "./sync";
import { hasCommandKey, IS_MAC, shortcut } from "./platform";
import { shortcutBlocked } from "./keys";
import { formatFps, tcOf } from "./timecode";
import {
  BarcodeStrip, EmptyState, GalleryPanel, rangeOf, ScopesPanel, StatusBar, Timeline, TimelinePanel, Toast, TopBar, Transport,
  UpdateBanner, Viewer, Warnings,
} from "./components";
import type { Compare, PreviewSize, ToastState, Zoom } from "./components";
import { ExtractPanel } from "./ExtractPanel";
import type { JobState, Output } from "./ExtractPanel";
import { LookPanel } from "./LookPanel";
import type { LayerId } from "./LookPanel";
import { OutputPanel } from "./OutputPanel";
import { PrefsDialog } from "./PrefsDialog";
import type { PrefsSection, UpdateState } from "./PrefsDialog";
import { CommandPalette, ShortcutsDialog } from "./CommandPalette";
import type { Command } from "./commands";
import type { SessionTab } from "./session";
import { SKINS } from "./theme";
import type {
  AnalysisSummary, AppInfo, BatchRequest, CaptureResult, FrameData, ImportedCuts, JobEvent, OverlayPreset, ScopeKind,
  Settings, ShotSource, ShotView, TabsView, UpdateInfo, VideoInfo,
} from "./types";

type Tab = SessionTab;

const TABS: [Tab, string][] = [["extract", "EXTRACT"], ["gallery", "GALLERY"], ["look", "LOOK"], ["output", "OUTPUT"]];

const imageOf = (f: FrameData) => new ImageData(f.rgba as Uint8ClampedArray<ArrayBuffer>, f.width, f.height);

/** Timecode affiché selon le réglage (le Rust applique la même règle). */
function withTcMode(info: VideoInfo, mode: Settings["export"]["timecode"]): VideoInfo {
  const timecode = mode === "zero" ? { ...info.fileTimecode, start: 0 } : info.fileTimecode;
  return info.timecode.start === timecode.start && info.timecode.drop === timecode.drop ? info : { ...info, timecode };
}

/**
 * Contrôle de synchro : un décalage n'est corrigé qu'après deux mesures
 * concordantes sur deux images différentes (`candidate`), jamais sur une seule.
 */
type SyncState = { status: "pending" | "ok" | "unavailable" | "corrected"; tries: number; candidate?: { offset: number; frame: number } };

export default function App() {
  const [rawInfo, setInfo] = useState<VideoInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<OverlayPreset[]>([]);
  const [captures, setCaptures] = useState<CaptureResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [warningsHidden, setWarningsHidden] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<Tab>("extract");
  const [analysis, setAnalysis] = useState<AnalysisSummary | null>(null);
  const [source, setSource] = useState<ShotSource>("detect");
  const [imported, setImported] = useState<ImportedCuts | null>(null);
  const [rawShots, setRawShots] = useState<ShotView[]>([]);
  const [removedCuts, setRemovedCuts] = useState<Set<number>>(new Set());
  const [addedCuts, setAddedCuts] = useState<Set<number>>(new Set());
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<JobState | null>(null);
  const [plan, setPlan] = useState<{ count: number | null; error: string | null }>({ count: null, error: null });
  const [output, setOutput] = useState<Output>("stills");
  const [marks, setMarks] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });
  const [preview, setPreview] = useState(false);
  const [still, setStill] = useState<FrameData | null>(null);
  const [stillLoading, setStillLoading] = useState(false);
  const [previewSize, setPreviewSize] = useState<PreviewSize | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [cors, setCors] = useState(true);
  const [syncOffset, setSyncOffset] = useState(0);
  const [sync, setSync] = useState<SyncState>({ status: "pending", tries: 0 });
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ checking: false, result: null, error: null });
  const [banner, setBanner] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState<{ done: number; total: number | null; installing: boolean } | null>(null);
  const [tabs, setTabs] = useState<TabsView>({ active: null, tabs: [] });
  const [switching, setSwitching] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<{ open: boolean; section: PrefsSection }>({ open: false, section: "appearance" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Film chargé (chemin), et film dont le projet est rechargé : on n'enregistre qu'après. */
  const filmRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  const restoreRef = useRef<(v: VideoInfo) => Promise<void>>(async () => {});

  const info = useMemo(() => (rawInfo && settings ? withTcMode(rawInfo, settings.export.timecode) : rawInfo), [rawInfo, settings]);
  const player = usePlayer(info, syncOffset, cors ? 1 : 0);
  const busyRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fail = useCallback((e: unknown) => {
    const m = errorMessage(e);
    if (m !== CANCELLED) setToast({ kind: "error", text: m });
  }, []);
  const closeToast = useCallback(() => setToast(null), []);

  /* ───── Réglages : état local immédiat, enregistrement Rust différé ───── */

  const latest = useRef<Settings | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  /** Envoie au Rust les réglages en attente ; à attendre avant toute action qui les lit. */
  const flush = useCallback((): Promise<void> => {
    clearTimeout(saveTimer.current);
    const s = latest.current;
    latest.current = null;
    if (s) {
      saving.current = saving.current.then(() =>
        api.updateSettings(s).then(
          () => {},
          (e) => {
            fail(e);
            return api.getSettings().then(setSettings);
          },
        ),
      );
    }
    return saving.current;
  }, [fail]);

  const changeSettings = useCallback((next: Settings) => {
    setSettings(next);
    latest.current = next;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 300);
  }, [flush]);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(fail);
    api.listPresets().then(setPresets).catch(fail);
    api.appInfo().then(setAppInfo).catch(() => {});
  }, [fail]);

  /* ───── Film ───── */

  const refreshTabs = useCallback(() => api.tabsList().then(setTabs).catch(() => {}), []);

  const loaded = useCallback((v: VideoInfo | null) => {
    if (!v) return;
    filmRef.current = v.path;
    sessionRef.current = null;
    setInfo(v);
    setCaptures([]);
    setWarningsHidden(false);
    setAnalysis(null);
    setImported(null);
    setSource("detect");
    setRawShots([]);
    setRemovedCuts(new Set());
    setAddedCuts(new Set());
    setUnchecked(new Set());
    setMarks({ start: null, end: null });
    setStill(null);
    setPreviewSize(null);
    setCompare(null);
    setZoom("fit");
    setSyncOffset(0);
    setSync({ status: "pending", tries: 0 });
    setOutput("stills");
    void refreshTabs();
    void restoreRef.current(v);
  }, [refreshTabs]);

  // Interface rechargée (développement) : le film reste ouvert côté Rust.
  // Sinon, au lancement : le film de l'onglet actif revient, avec son projet.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const v = await api.currentVideo();
        if (v) return loaded(v);
        const t = await api.tabsList();
        setTabs(t);
        const active = t.tabs.find((x) => x.key === t.active);
        if (active && !active.missing) loaded(await api.tabOpen(active.key));
      } catch (e) {
        fail(e);
      }
    })();
  }, [loaded, fail]);

  /** Film déchargé (dernier onglet fermé). */
  const unloaded = useCallback(() => {
    filmRef.current = null;
    sessionRef.current = null;
    setInfo(null);
    setCaptures([]);
    setAnalysis(null);
    setImported(null);
    setRawShots([]);
    setStill(null);
    setCompare(null);
  }, []);

  const openDialog = useCallback(() => api.pickVideo().then(loaded).catch(fail), [loaded, fail]);

  const chooseDir = useCallback(async (): Promise<boolean> => {
    await flush();
    try {
      const s = await api.pickOutputDir();
      if (!s) return false;
      setSettings(s);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }, [flush, fail]);

  /** Réglages enregistrés et dossier de sortie présent. */
  const ready = useCallback(async (): Promise<Settings | null> => {
    await flush();
    const s = latest.current ?? settings;
    if (!s) return null;
    if (!s.outputDir && !(await chooseDir())) return null;
    return s;
  }, [flush, settings, chooseDir]);

  /* ───── Plans ───── */

  // Réglages enregistrés dont dépendent, côté Rust, les vignettes des plans (image retenue)
  // et l'image exacte (palette, profil couleur, timecode). Les autres réglages (overlay,
  // planche, fichiers…) ne relancent ni FFmpeg ni la liste des plans.
  const pickKey = settings ? JSON.stringify(settings.shots.pick) : "";
  const frameKey = settings ? JSON.stringify([settings.palette, settings.export.color, settings.export.timecode]) : "";
  const threshold = useDebounced(settings?.shots.threshold ?? 10, 120);
  const minSeconds = useDebounced(settings?.shots.minSeconds ?? 0.5, 120);
  const extraCuts = useMemo(() => [...addedCuts].sort((a, b) => a - b), [addedCuts]);
  useEffect(() => {
    const ok = source === "detect" ? analysis !== null : imported !== null;
    if (!ok) {
      setRawShots([]);
      return;
    }
    let alive = true;
    // Les vignettes dépendent de l'image retenue, lue côté Rust : enregistrer d'abord.
    flush()
      .then(() => api.listShots(source, threshold, minSeconds, extraCuts))
      .then((s) => alive && setRawShots(s))
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [analysis, imported, source, threshold, minSeconds, extraCuts, pickKey, flush, fail]);

  const shots = useMemo(() => buildShots(rawShots, removedCuts, unchecked, addedCuts), [rawShots, removedCuts, unchecked, addedCuts]);
  const cuts = useMemo(() => shots.slice(1).filter((s) => !s.manual).map((s) => s.start), [shots]);
  const manualCuts = useMemo(() => shots.filter((s) => s.manual).map((s) => s.start), [shots]);
  const currentShot = useMemo(() => shotAt(shots, player.frame), [shots, player.frame]);

  const toggleShot = useCallback((start: number) => {
    setUnchecked((u) => {
      const n = new Set(u);
      if (n.has(start)) n.delete(start);
      else n.add(start);
      return n;
    });
  }, []);
  const mergeShot = useCallback((i: number) => setRemovedCuts((r) => mergeWithNext(shots, i, r)), [shots]);
  const setAll = useCallback((v: boolean | "invert") => {
    if (v === true) setUnchecked(new Set());
    else if (v === false) setUnchecked(new Set(shots.map((s) => s.start)));
    else setUnchecked(new Set(shots.filter((s) => s.checked).map((s) => s.start)));
  }, [shots]);
  const cutHere = useCallback(() => {
    const f = player.frameRef.current;
    if (!info || f <= 0 || f >= info.frameCount) return;
    if (shots.some((s) => s.start === f)) {
      setToast({ kind: "ok", text: "There is already a cut here." });
      return;
    }
    const next = cutAt(f, addedCuts, removedCuts);
    setAddedCuts(next.added);
    setRemovedCuts(next.removed);
  }, [player.frameRef, info, shots, addedCuts, removedCuts]);
  const resetEdits = useCallback(() => {
    setRemovedCuts(new Set());
    setAddedCuts(new Set());
  }, []);

  const importCuts = useCallback(async () => {
    try {
      const c = await api.importCuts();
      if (!c) return;
      setImported(c);
      setSource("imported");
      setRemovedCuts(new Set());
      setAddedCuts(new Set());
      setUnchecked(new Set());
      setToast({ kind: "ok", text: `${c.shots} shots imported from ${c.fileName}` });
    } catch (e) {
      fail(e);
    }
  }, [fail]);
  const clearImport = useCallback(() => {
    void api.clearCuts();
    setImported(null);
    setSource("detect");
    resetEdits();
  }, [resetEdits]);

  /* ───── Plage et plan d'export ───── */

  const range = useMemo(() => (info ? rangeOf(marks, info.frameCount) : null), [marks, info]);
  const haveList = source === "imported" ? imported !== null : analysis !== null;
  const request = useMemo((): BatchRequest | null => {
    if (!settings) return null;
    const b = settings.batch;
    if (b.mode === "shots") return haveList ? { kind: "shots", shots: selectedSpans(shots), pick: settings.shots.pick } : null;
    if (b.mode === "interval") return { kind: "interval", seconds: b.intervalSeconds };
    return { kind: "spread", count: b.spreadCount };
  }, [settings, haveList, shots]);

  const debouncedRequest = useDebounced(request, 150);
  useEffect(() => {
    if (!info || !debouncedRequest) {
      setPlan({ count: null, error: null });
      return;
    }
    let alive = true;
    api.batchPlan(debouncedRequest, range)
      .then((p) => alive && setPlan({ count: p.count, error: null }))
      .catch((e) => alive && setPlan({ count: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [info, debouncedRequest, range]);

  const sheetPages = useMemo(() => {
    if (!info || !settings || output !== "sheet" || !plan.count) return null;
    return sheetLayout(settings.sheet, info.outWidth, info.outHeight, plan.count).pages;
  }, [info, settings, output, plan.count]);

  /* ───── Travaux longs ───── */

  const onJobEvent = useCallback((e: JobEvent) => {
    switch (e.kind) {
      case "progress":
        setJob((j) => (j && j.kind !== "sheet" ? { ...j, phase: e.phase, done: e.done, total: e.total } : j));
        break;
      case "written":
        setCaptures((c) => [e.capture, ...c]);
        break;
      case "done":
        setJob(null);
        if (e.file) {
          const name = e.file.split(/[\\/]/).pop();
          setToast({ kind: "ok", text: `Contact sheet saved: ${name}${e.written > 1 ? ` (${e.written} pages)` : ""}`, show: { path: e.file } });
        } else {
          setToast({ kind: "ok", text: `${e.written} frames exported${e.csv ? " + CSV list" : ""}`, show: e.written ? { path: e.dir, folder: true } : undefined });
        }
        break;
      case "failed":
        setJob(null);
        fail(e.message);
        break;
      case "cancelled":
        setJob(null);
        setToast({ kind: "ok", text: "Export cancelled. Files already written are kept." });
        break;
    }
  }, [fail]);

  const analyze = useCallback(async () => {
    if (!info || job) return;
    await flush();
    setJob({ kind: "analysis", phase: "analysis-cpu", done: 0, total: info.frameCount, startedAt: performance.now() });
    try {
      const sum = await api.analyze(onJobEvent);
      setAnalysis(sum);
      if (source === "detect") {
        setRemovedCuts(new Set());
        setUnchecked(new Set());
      }
      setToast({ kind: "ok", text: `Analysis done in ${sum.seconds.toFixed(1)} s` });
    } catch (e) {
      fail(e);
    } finally {
      setJob(null);
    }
  }, [info, job, source, flush, onJobEvent, fail]);

  const cancelJob = useCallback(() => {
    if (job?.kind === "analysis") void api.cancelAnalysis();
    else void api.batchCancel();
  }, [job]);

  /** Mode composition : tire chaque image, applique l'overlay, renvoie le résultat. */
  const composeLoop = useCallback(async (jobId: number, s: Settings, v: VideoInfo) => {
    const preset = s.overlay;
    await loadFonts(preset);
    let next = api.batchPull(jobId);
    // Jusqu'à 2 écritures (encodage côté Rust) pendant qu'on compose la suivante.
    const writes: Promise<unknown>[] = [];
    try {
      for (;;) {
        const f = await next;
        if (!f) break;
        next = api.batchPull(jobId); // décodage de la suivante pendant la composition
        next.catch(() => {});
        const tokens = makeTokens(v.fileName, f.timecode, f.frame, f.shot, v.fps, f.width, f.height, f.clip);
        const c = composeToPixels(imageOf(f), preset, f.palette, tokens);
        const w = api.writeComposed({ frame: f.frame, width: c.width, height: c.height, job: jobId, shot: f.shot }, c.rgba);
        w.catch(() => {});
        writes.push(w);
        if (writes.length >= 2) await writes.shift();
      }
      for (const w of writes) await w;
      await api.batchFinish(jobId);
    } catch (e) {
      if (errorMessage(e) !== CANCELLED) {
        void api.batchCancel();
        fail(e);
      }
      setJob(null);
    }
  }, [fail]);

  /** Planche contact : tire les vignettes, compose les pages, les envoie. */
  const sheetLoop = useCallback(async (jobId: number, s: Settings, v: VideoInfo, L: SheetLayout, total: number) => {
    await document.fonts.load(`500 16px "IBM Plex Mono"`).catch(() => {});
    await document.fonts.load(`600 16px "Barlow Condensed"`).catch(() => {});
    const canvas = new OffscreenCanvas(L.pageW, L.pageH);
    const title = expandTitle(s.sheet.title, v.fileName.replace(/\.[^.]+$/, ""), total);
    let cells: SheetCell[] = [];
    let page = 0;
    let first = "";
    let done = 0;
    const flushPage = async (last: string) => {
      if (!cells.length) return;
      page += 1;
      const subtitle = `${v.fileName} · ${v.outWidth}×${v.outHeight} · ${formatFps(v.fps)} · ${first} – ${last} · ${total} frames`;
      drawPage(canvas, L, s.sheet, cells, { title, subtitle, page, pages: L.pages });
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      await api.sheetPage(jobId, L.pageW, L.pageH, ctx.getImageData(0, 0, L.pageW, L.pageH).data);
      cells = [];
      first = "";
    };
    try {
      let next = api.batchPull(jobId);
      let lastTc = "";
      for (;;) {
        const f = await next;
        if (!f) break;
        next = api.batchPull(jobId);
        next.catch(() => {});
        if (!first) first = f.timecode;
        lastTc = f.timecode;
        cells.push({ image: imageOf(f), tc: f.timecode, frame: f.frame, shot: f.shot, clip: f.clip, palette: f.palette });
        done += 1;
        setJob((j) => (j ? { ...j, done } : j));
        if (cells.length === L.perPage) await flushPage(lastTc);
      }
      await flushPage(lastTc);
      await api.batchFinish(jobId);
    } catch (e) {
      if (errorMessage(e) !== CANCELLED) {
        void api.batchCancel();
        fail(e);
      }
      setJob(null);
    }
  }, [fail]);

  const exportBatch = useCallback(async () => {
    if (!info || !request || job) return;
    const s = await ready();
    if (!s) return;
    try {
      if (output === "sheet") {
        const count = plan.count ?? 0;
        const L = sheetLayout(s.sheet, info.outWidth, info.outHeight, count);
        setJob({ kind: "sheet", phase: "sheet", done: 0, total: count, startedAt: performance.now() });
        const started = await api.batchStart(request, range, { kind: "sheet", cellWidth: L.cellW }, onJobEvent);
        setJob((j) => (j ? { ...j, total: started.total } : j));
        void sheetLoop(started.job, s, info, L, started.total);
      } else {
        const compose = s.export.overlay;
        setJob({ kind: "export", phase: "export", done: 0, total: plan.count ?? 0, startedAt: performance.now() });
        const started = await api.batchStart(request, range, { kind: "stills", compose }, onJobEvent);
        setJob((j) => (j ? { ...j, total: started.total } : j));
        if (compose) void composeLoop(started.job, s, info);
      }
      // La progression s'affiche dans Extract ; Gallery montre les images qui arrivent.
      setTab((t) => (t === "gallery" ? t : "extract"));
    } catch (e) {
      setJob(null);
      fail(e);
    }
  }, [info, request, job, ready, output, plan.count, range, onJobEvent, composeLoop, sheetLoop, fail]);

  const exportBarcode = useCallback(async () => {
    if (!(await ready())) return;
    try {
      const r = await api.exportBarcode();
      setToast({ kind: "ok", text: `${r.fileName} saved (${r.width}×${r.height})`, show: { path: r.path } });
    } catch (e) {
      fail(e);
    }
  }, [ready, fail]);

  /* ───── Capture à l'unité ───── */

  const capture = useCallback(async () => {
    if (!info || busyRef.current) return;
    // On fige l'image affichée au moment de l'appui, même si la lecture continue.
    const frame = player.frameRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const s = await ready();
      if (!s) return;
      let res: CaptureResult;
      if (s.export.overlay) {
        const f = await api.grabFrame(frame);
        await loadFonts(s.overlay);
        const tokens = makeTokens(info.fileName, f.timecode, f.frame, null, info.fps, f.width, f.height, f.clip);
        const c = composeToPixels(imageOf(f), s.overlay, f.palette, tokens);
        res = await api.writeComposed({ frame, width: c.width, height: c.height }, c.rgba);
      } else {
        res = await api.capture(frame);
      }
      setCaptures((c) => [res, ...c]);
      setToast({ kind: "ok", text: `${res.fileName} saved`, show: { path: res.path } });
    } catch (e) {
      fail(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [info, player.frameRef, ready, fail]);

  const savePalette = useCallback(async () => {
    if (!info || !(await ready())) return;
    try {
      const files = await api.savePalette(player.frameRef.current);
      setToast({ kind: "ok", text: `Palette saved: ${files.map((f) => f.split(".").pop()).join(", ")}`, show: files[0] ? { path: files[0] } : undefined });
    } catch (e) {
      fail(e);
    }
  }, [info, ready, player.frameRef, fail]);

  /* ───── Image exacte arrêtée : aperçu d'export, scopes, référence A/B ───── */

  const scopesOpen = settings?.ui.scopesOpen ?? false;
  const settledFrame = useDebounced(player.frame, 120);
  const wantStill = (preview || scopesOpen) && !player.playing;
  useEffect(() => {
    if (!wantStill || !info) return;
    let alive = true;
    setStillLoading(true);
    flush()
      .then(() => api.grabFrame(settledFrame))
      .then((f) => alive && setStill(f))
      .catch((e) => alive && fail(e))
      .finally(() => alive && setStillLoading(false));
    return () => {
      alive = false;
    };
    // frameKey : la palette, la conversion et le timecode dépendent des réglages enregistrés (flush d'abord).
  }, [wantStill, info, settledFrame, frameKey, flush, fail]);

  const setReference = useCallback(async () => {
    if (!info) return;
    try {
      await flush();
      const f = await api.grabFrame(player.frameRef.current);
      setCompare({ ref: f, on: true, split: 0.5 });
      setToast({ kind: "ok", text: `Reference A: ${f.timecode}. Drag the wipe, W turns it off.` });
    } catch (e) {
      fail(e);
    }
  }, [info, flush, player.frameRef, fail]);

  // The preview always draws the overlay so every overlay and palette setting is visible live,
  // even when "Apply the overlay to exports" is off (a note on the preview says so).
  const effectivePreset = settings ? settings.overlay : null;
  // Opening the LOOK tab turns the preview on: the look is edited while watching the result.
  useEffect(() => {
    if (tab === "look") setPreview(true);
  }, [tab]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!preview || !still || !c || !effectivePreset || !info) return;
    let alive = true;
    loadFonts(effectivePreset).then(() => {
      if (!alive) return;
      const tokens = makeTokens(info.fileName, still.timecode, still.frame, null, info.fps, still.width, still.height, still.clip);
      const L = render(c, imageOf(still), effectivePreset, still.palette, tokens);
      setPreviewSize((p) =>
        p && p.w === L.width && p.h === L.height && p.image.x === L.image.x && p.image.y === L.image.y
          ? p
          : { w: L.width, h: L.height, image: L.image });
    });
    return () => {
      alive = false;
    };
  }, [preview, still, effectivePreset, info]);

  /*
   * Aperçu instantané : dès que la visionneuse montre la nouvelle image, l'aperçu est
   * redessiné depuis elle (cadre, textes, palette précédente), puis remplacé par l'image
   * exacte de FFmpeg (couleurs converties, palette) quand elle arrive. L'aperçu reste
   * entier et suit la navigation sans attendre le décodage (plusieurs secondes en 4K).
   */
  const target = player.frame;
  useEffect(() => {
    const v = player.videoRef.current;
    if (!preview || player.playing || !cors || !info || !v || !still || still.frame === target) return;
    let alive = true;
    let raf = 0;
    const draw = () => {
      if (!alive) return;
      // Image pas encore décodée : on réessaie à l'affichage suivant.
      if (v.seeking || v.readyState < 2) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const c = new OffscreenCanvas(info.outWidth, info.outHeight);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, info.outWidth, info.outHeight);
      const rgba = ctx.getImageData(0, 0, info.outWidth, info.outHeight).data;
      // L'image exacte, si elle est déjà là, n'est jamais remplacée par l'approximation.
      setStill((s) => (s && (s.frame !== target || s.provisional)
        ? { ...s, frame: target, timecode: tcOf(info, target), width: info.outWidth, height: info.outHeight, rgba, provisional: true }
        : s));
    };
    draw();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [preview, player.playing, player.videoRef, cors, info, still, target]);

  /* ───── Synchro visionneuse ↔ FFmpeg (une fois par film) ───── */

  useEffect(() => {
    if (!info || player.playing || sync.status !== "pending" || sync.tries >= 6 || settledFrame === 0) return;
    const v = player.videoRef.current;
    if (!v || v.readyState < 2 || v.seeking) return;
    if (sync.candidate && sync.candidate.frame === settledFrame) return;
    let alive = true;
    const t = setTimeout(() => {
      if (v.seeking) return;
      checkSync(v, settledFrame, info.frameCount)
        .then((r) => {
          if (!alive) return;
          const tries = sync.tries + 1;
          if (r.kind === "ok") setSync({ status: "ok", tries });
          else if (r.kind === "offset") {
            if (sync.candidate && sync.candidate.offset === r.offset) {
              setSyncOffset((o) => o + r.offset);
              setSync({ status: "corrected", tries });
              setToast({ kind: "ok", text: `The viewer was ${Math.abs(r.offset)} frame ${r.offset > 0 ? "behind" : "ahead of"} the file (offset start). Corrected: captures match the displayed frame.` });
            } else {
              // Première mesure : on attend une confirmation sur une autre image.
              setSync({ status: "pending", tries, candidate: { offset: r.offset, frame: settledFrame } });
            }
          } else if (r.reason.includes("read back")) setSync({ status: "unavailable", tries: 4 });
          else setSync({ status: "pending", tries, candidate: sync.candidate });
        })
        .catch(() => alive && setSync({ status: "pending", tries: sync.tries + 1, candidate: sync.candidate }));
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [info, player.playing, player.videoRef, settledFrame, sync]);

  /* ───── Mises à jour ───── */

  /** Vérification demandée : la bannière s'affiche même pour une version ignorée. */
  const checkUpdate = useCallback(async () => {
    setUpdate((u) => ({ ...u, checking: true, error: null }));
    try {
      const r = await api.checkUpdate();
      setUpdate({ checking: false, result: r, error: null });
      if (r.version) setBanner(r);
    } catch (e) {
      setUpdate({ checking: false, result: null, error: errorMessage(e) });
    }
  }, []);
  const startupChecked = useRef(false);
  useEffect(() => {
    if (startupChecked.current || !settings || !appInfo) return;
    startupChecked.current = true;
    if (!appInfo.updatesEnabled || !settings.updates.checkAtStartup) return;
    const t = setTimeout(() => {
      void api.checkUpdate().then((r) => {
        setUpdate({ checking: false, result: r, error: null });
        if (r.version && r.version !== settings.updates.skipped) setBanner(r);
      }).catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, [settings, appInfo]);
  const installUpdate = useCallback(async () => {
    setInstalling({ done: 0, total: null, installing: false });
    try {
      await api.installUpdate((e) => {
        if (e.kind === "progress") setInstalling({ done: e.downloaded, total: e.total, installing: false });
        else setInstalling((p) => ({ done: p?.done ?? 0, total: p?.total ?? null, installing: true }));
      });
    } catch (e) {
      setInstalling(null);
      fail(e);
    }
  }, [fail]);

  /* ───── Projet du film : reprise et enregistrement continu ───── */

  const seekRef = useRef(player.seek);
  seekRef.current = player.seek;
  restoreRef.current = async (v: VideoInfo) => {
    try {
      const r = await api.projectRestore();
      if (filmRef.current !== v.path) return;
      if (r.imported) setImported(r.imported);
      if (r.analysis) setAnalysis(r.analysis);
      const ui = parseSession(r.ui, v.frameCount);
      if (ui) {
        setSource(ui.source === "imported" && r.imported ? "imported" : "detect");
        setRemovedCuts(new Set(ui.removedCuts));
        setAddedCuts(new Set(ui.addedCuts));
        setUnchecked(new Set(ui.unchecked));
        setMarks(ui.marks);
        setCaptures(ui.captures);
        setOutput(ui.output);
        setTab(ui.tab);
        if (ui.frame > 0) seekRef.current(ui.frame);
      }
      if (r.filmChanged) setToast({ kind: "ok", text: "This file changed since last time: your selections are back, analyze it again." });
      else if (ui || r.analysis) setToast({ kind: "ok", text: r.analysis ? "Project restored, analysis included." : "Project restored." });
    } catch (e) {
      fail(e);
    } finally {
      if (filmRef.current === v.path) {
        sessionRef.current = v.path;
        setSessionTick((t) => t + 1);
      }
    }
  };

  // Ce qu'on enregistre, lu au moment d'écrire (pas à chaque image de lecture).
  const sessionState = useRef({ source, removedCuts, addedCuts, unchecked, marks, captures, output, tab });
  sessionState.current = { source, removedCuts, addedCuts, unchecked, marks, captures, output, tab };
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveSession = useCallback((): Promise<void> => {
    clearTimeout(sessionTimer.current);
    const path = filmRef.current;
    if (!path || sessionRef.current !== path) return Promise.resolve();
    const ui = snapshot({ ...sessionState.current, frame: player.frameRef.current });
    // Le Rust vérifie que ce film est toujours celui ouvert avant d'écrire.
    return api.projectSave(path, ui).catch(() => {});
  }, [player.frameRef]);
  const slowFrame = useDebounced(player.frame, 1500);
  useEffect(() => {
    if (!sessionRef.current) return;
    clearTimeout(sessionTimer.current);
    sessionTimer.current = setTimeout(() => void saveSession(), 600);
  }, [source, removedCuts, addedCuts, unchecked, marks, captures, output, tab, slowFrame, player.playing, sessionTick, saveSession]);
  useEffect(() => () => clearTimeout(sessionTimer.current), []);

  /* ───── Onglets ───── */

  const switchTab = useCallback(async (key: string) => {
    if (job) {
      setToast({ kind: "ok", text: "Wait for the current job to finish (or cancel it) before switching films." });
      return;
    }
    setSwitching(key);
    try {
      await saveSession();
      loaded(await api.tabOpen(key));
    } catch (e) {
      fail(e);
      void refreshTabs();
    } finally {
      setSwitching(null);
    }
  }, [job, saveSession, loaded, fail, refreshTabs]);

  const closeTab = useCallback(async (key: string) => {
    const wasActive = key === tabs.active;
    if (wasActive && job) {
      setToast({ kind: "ok", text: "Wait for the current job to finish (or cancel it) before closing this film." });
      return;
    }
    if (wasActive) await saveSession();
    try {
      const next = await api.tabClose(key);
      setTabs(next);
      if (!wasActive) return;
      // Onglet voisin, sinon écran d'accueil.
      const i = tabs.tabs.findIndex((t) => t.key === key);
      const neighbour = next.tabs[Math.min(i, next.tabs.length - 1)];
      if (neighbour && !neighbour.missing) await switchTab(neighbour.key);
      else unloaded();
    } catch (e) {
      fail(e);
    }
  }, [tabs, job, saveSession, switchTab, unloaded, fail]);

  const newTab = useCallback(async () => {
    if (job) {
      setToast({ kind: "ok", text: "Wait for the current job to finish (or cancel it) before opening another film." });
      return;
    }
    await saveSession();
    await openDialog();
  }, [job, saveSession, openDialog]);

  /* ───── Glisser-déposer et clavier ───── */

  useEffect(() => {
    // Le film déposé est ouvert côté Rust ; ici, seulement le retour visuel.
    let unDrag: (() => void) | undefined;
    let unFilm: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") setDragging(true);
        else if (p.type === "leave" || p.type === "drop") setDragging(false);
      })
      .then((u) => (unDrag = u))
      .catch(() => {});
    api.onFilm((e) => (e.kind === "opened" ? loaded(e.info) : fail(e.message)))
      .then((u) => (unFilm = u))
      .catch(() => {});
    return () => {
      unDrag?.();
      unFilm?.();
    };
  }, [loaded, fail]);

  const setUi = useCallback((patch: Partial<Settings["ui"]>) => {
    if (settings) changeSettings({ ...settings, ui: { ...settings.ui, ...patch } });
  }, [settings, changeSettings]);

  // Apparence : suit les réglages (enregistrés côté Rust), copiée localement pour le prochain lancement.
  const theme = settings?.ui.theme;
  const skin = settings?.ui.skin;
  const effects = settings?.ui.effects;
  const accent = settings?.ui.accent ?? "gold";
  useEffect(() => {
    if (theme && skin && effects !== undefined) applyAppearance({ theme, skin, effects, accent });
  }, [theme, skin, effects, accent]);
  const openPrefs = useCallback((section?: PrefsSection) => setPrefs((p) => ({ open: true, section: section ?? p.section })), []);

  // Son de la visionneuse : réglage mémorisé, appliqué à chaque nouvelle balise <video>.
  const muted = settings?.ui.muted ?? false;
  const toggleMute = useCallback(() => setUi({ muted: !muted }), [setUi, muted]);
  useEffect(() => {
    if (player.videoRef.current) player.videoRef.current.muted = muted;
  }, [muted, info, cors, player.videoRef]);

  // Raccourcis clavier, ignorés quand on tape dans un champ.
  const { togglePlay, step, seek, shuttle } = player;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Une fenêtre (préférences, commandes, aide) est ouverte : elle a le clavier.
      if (document.querySelector("dialog[open]")) return;
      if (shortcutBlocked(e)) return;
      // ⌘ sur Mac, Ctrl sous Windows.
      if (hasCommandKey(e) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void newTab();
        return;
      }
      if (hasCommandKey(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (hasCommandKey(e) && e.key === ",") {
        e.preventDefault();
        openPrefs();
        return;
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!info) return;
      const sec = Math.round(info.fps);
      const k = e.key.toLowerCase();
      // Sur Mac, Option+X donne « ≈ » dans e.key : on teste aussi la touche physique.
      if (e.altKey && (k === "x" || e.code === "KeyX")) {
        e.preventDefault();
        setMarks({ start: null, end: null });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (hasCommandKey(e) && k === "b") {
          e.preventDefault();
          cutHere();
        }
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          return;
        case "ArrowLeft":
          e.preventDefault();
          step(e.shiftKey ? -sec : -1);
          return;
        case "ArrowRight":
          e.preventDefault();
          step(e.shiftKey ? sec : 1);
          return;
        case "Home":
          seek(0);
          return;
        case "End":
          seek(info.frameCount - 1);
          return;
      }
      if (e.repeat && k !== "j" && k !== "l") return;
      switch (k) {
        case "c":
          void capture();
          break;
        case "p":
          setPreview((p) => !p);
          break;
        case "j":
          shuttle(-1);
          break;
        case "k":
          shuttle(0);
          break;
        case "l":
          shuttle(1);
          break;
        case "i":
          setMarks((m) => ({ start: player.frameRef.current, end: m.end != null && m.end < player.frameRef.current ? null : m.end }));
          break;
        case "o":
          setMarks((m) => ({ start: m.start != null && m.start > player.frameRef.current ? null : m.start, end: player.frameRef.current }));
          break;
        case "b":
          cutHere();
          break;
        case "z":
          setZoom((z) => (z === "fit" ? 1 : z === 1 ? 2 : "fit"));
          break;
        case "r":
          void setReference();
          break;
        case "w":
          setCompare((c) => (c ? { ...c, on: !c.on } : c));
          break;
        case "s":
          setUi({ scopesOpen: !scopesOpen });
          break;
        case "m":
          toggleMute();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info, togglePlay, step, seek, shuttle, capture, newTab, cutHere, setReference, setUi, scopesOpen, player.frameRef, openPrefs, toggleMute]);

  // Un repère par image capturée (deux captures de la même image : un seul repère, clé unique).
  const markers = useMemo(() => [...new Set(captures.map((c) => c.frame))].slice(0, 300), [captures]);
  const previewState = player.playing ? "playing" : stillLoading && preview ? "loading" : still ? "ready" : "idle";
  const appearance = settings ? { theme: settings.ui.theme, skin: settings.ui.skin, effects: settings.ui.effects, accent: settings.ui.accent ?? "gold" } : null;
  const shownTheme = appearance ? effectiveTheme(appearance) : "dark";
  const [lookLayer, setLookLayer] = useState<LayerId>("frame");
  const syncNote = sync.status === "corrected" ? `Viewer offset ${syncOffset > 0 ? "+" : ""}${syncOffset} frame corrected` : null;

  /* ───── Palette de commandes ───── */

  const commands = useMemo((): Command[] => {
    if (!settings) return [];
    const s = settings;
    const noFilm = !info;
    const onOff = (v: boolean) => (v ? "On" : "Off");
    const goto = (t: Tab) => () => setTab(t);
    const look = (l: LayerId) => () => {
      setTab("look");
      setLookLayer(l);
    };
    const exportLabel = output === "sheet" ? "Make the contact sheet" : `Export ${plan.count ?? ""} ${s.export.format === "png" ? "PNG" : "JPEG"} stills`.replace("  ", " ");
    const list: Command[] = [
      { id: "open", group: "Film", label: "Open a film", shortcut: shortcut("O"), keywords: "file video load", run: () => void newTab() },
      { id: "close-tab", group: "Film", label: "Close this film tab", disabled: !tabs.active, keywords: "tab", run: () => tabs.active && void closeTab(tabs.active) },
      { id: "play", group: "Playback", label: player.playing ? "Pause" : "Play", shortcut: "Space", disabled: noFilm, run: () => togglePlay() },
      { id: "first", group: "Playback", label: "Go to the first frame", shortcut: "Home", disabled: noFilm, keywords: "start", run: () => seek(0) },
      { id: "last", group: "Playback", label: "Go to the last frame", shortcut: "End", disabled: noFilm, keywords: "end", run: () => info && seek(info.frameCount - 1) },
      { id: "in", group: "Playback", label: "Mark in", shortcut: "I", disabled: noFilm, keywords: "range point", run: () => setMarks((m) => ({ start: player.frameRef.current, end: m.end != null && m.end < player.frameRef.current ? null : m.end })) },
      { id: "out", group: "Playback", label: "Mark out", shortcut: "O", disabled: noFilm, keywords: "range point", run: () => setMarks((m) => ({ start: m.start != null && m.start > player.frameRef.current ? null : m.start, end: player.frameRef.current })) },
      { id: "clear-marks", group: "Playback", label: "Clear in and out", shortcut: `${IS_MAC ? "⌥" : "Alt"} + X`, disabled: noFilm || (marks.start == null && marks.end == null), run: () => setMarks({ start: null, end: null }) },
      { id: "cut", group: "Playback", label: "Add a cut at the playhead", shortcut: "B", disabled: noFilm, keywords: "shot split", run: cutHere },
      { id: "capture", group: "Frames", label: "Capture the displayed frame", shortcut: "C", disabled: noFilm, keywords: "still screenshot grab", run: () => void capture() },
      { id: "ref", group: "Frames", label: "Set the displayed frame as reference A", shortcut: "R", disabled: noFilm, keywords: "a/b compare", run: () => void setReference() },
      { id: "wipe", group: "Frames", label: "A/B wipe", value: compare ? onOff(compare.on) : undefined, shortcut: "W", disabled: !compare, keywords: "compare", run: () => setCompare((c) => (c ? { ...c, on: !c.on } : c)) },
      { id: "preview", group: "Frames", label: "Export preview", value: onOff(preview), shortcut: "P", disabled: noFilm, keywords: "overlay look", run: () => setPreview((p) => !p) },
      { id: "mute", group: "Playback", label: "Sound", value: muted ? "Off" : "On", shortcut: "M", disabled: noFilm, keywords: "mute audio volume", run: toggleMute },
      { id: "scopes", group: "Frames", label: "Scopes", value: onOff(scopesOpen), shortcut: "S", disabled: noFilm, keywords: "waveform parade vectorscope histogram", run: () => setUi({ scopesOpen: !scopesOpen }) },
      ...([["fit", "Zoom: fit"], [1, "Zoom: 100 %"], [2, "Zoom: 200 %"]] as [Zoom, string][]).map(([z, l]): Command => ({
        id: `zoom-${z}`, group: "Frames", label: l, shortcut: "Z", disabled: noFilm, value: zoom === z ? "Current" : undefined, run: () => setZoom(z),
      })),
      { id: "analyze", group: "Extract", label: analysis ? "Re-analyze the film" : "Analyze the film", disabled: noFilm || !!job, keywords: "detect shots cuts scdet barcode", run: () => void analyze() },
      { id: "import", group: "Extract", label: "Import an edit list", disabled: noFilm || !!job, keywords: "edl otio xml fcpxml cuts", run: () => void importCuts() },
      ...([["shots", "By shot"], ["interval", "Every X seconds"], ["spread", "N frames spread over the film"]] as [Settings["batch"]["mode"], string][]).map(([m, l]): Command => ({
        id: `mode-${m}`, group: "Extract", label: `Extract: ${l}`, value: s.batch.mode === m ? "Current" : undefined, disabled: !!job,
        run: () => {
          changeSettings({ ...s, batch: { ...s.batch, mode: m } });
          setTab("extract");
        },
      })),
      { id: "output-stills", group: "Extract", label: "Output: stills", value: output === "stills" ? "Current" : undefined, run: () => { setOutput("stills"); setTab("extract"); } },
      { id: "output-sheet", group: "Extract", label: "Output: contact sheet", value: output === "sheet" ? "Current" : undefined, keywords: "pdf grid print", run: () => { setOutput("sheet"); setTab("extract"); } },
      { id: "export", group: "Extract", label: exportLabel, disabled: noFilm || !!job || !plan.count, keywords: "batch export render sheet", run: () => void exportBatch() },
      { id: "cancel", group: "Extract", label: "Cancel the current job", disabled: !job, keywords: "stop", run: cancelJob },
      { id: "barcode", group: "Extract", label: "Export the barcode", disabled: !analysis, keywords: "colors", run: () => void exportBarcode() },
      { id: "all", group: "Extract", label: "Select all shots", disabled: !shots.length, run: () => setAll(true) },
      { id: "none", group: "Extract", label: "Select no shot", disabled: !shots.length, run: () => setAll(false) },
      { id: "invert", group: "Extract", label: "Invert the shot selection", disabled: !shots.length, run: () => setAll("invert") },
      { id: "undo-edits", group: "Extract", label: "Undo cut edits (merges and added cuts)", disabled: !removedCuts.size && !addedCuts.size, run: resetEdits },
      { id: "palette-save", group: "Gallery", label: "Save this frame's palette (.ase .css .gpl .json)", disabled: noFilm, keywords: "colors swatches", run: () => void savePalette() },
      { id: "open-folder", group: "Gallery", label: "Show the output folder", disabled: !s.outputDir, keywords: "explorer finder", run: () => void api.openFolder().catch(fail) },
      { id: "apply-look", group: "Look", label: "Apply the look to exported stills", value: onOff(s.export.overlay), keywords: "overlay burn", run: () => changeSettings({ ...s, export: { ...s.export, overlay: !s.export.overlay } }) },
      { id: "look-frame", group: "Look", label: "Look › Frame (margins, background)", run: look("frame") },
      { id: "look-palette", group: "Look", label: "Look › Palette band", value: onOff(s.overlay.palette.enabled), keywords: "colors swatches count weighting accents", run: look("palette") },
      { id: "look-scope", group: "Look", label: "Look › Scope burnt into the image", value: onOff(s.overlay.scope.enabled), run: look("scope") },
      ...s.overlay.texts.map((t, i): Command => ({ id: `look-text-${i}`, group: "Look", label: `Look › Text: ${t.template || "(empty)"}`, value: onOff(t.enabled), run: look(`text:${i}`) })),
      ...presets.map((p): Command => ({
        id: `preset-${p.name}`, group: "Look", label: `Load the preset “${p.name}”`, value: s.overlay.name === p.name ? "Current" : undefined, keywords: "overlay",
        run: () => changeSettings({ ...s, overlay: structuredClone(p) }),
      })),
      { id: "dir", group: "Output", label: "Choose the output folder", value: s.outputDir ?? "Not set", keywords: "destination", run: () => void chooseDir() },
      { id: "format", group: "Output", label: "Stills format", value: s.export.format === "png" ? "PNG" : "JPEG", keywords: "jpeg png", run: () => changeSettings({ ...s, export: { ...s.export, format: s.export.format === "png" ? "jpeg" : "png" } }) },
      { id: "subfolder", group: "Output", label: "Batch exports in a subfolder", value: onOff(s.export.subfolder), run: () => changeSettings({ ...s, export: { ...s.export, subfolder: !s.export.subfolder } }) },
      { id: "csv", group: "Output", label: "Write a CSV list", value: onOff(s.export.csv), keywords: "excel", run: () => changeSettings({ ...s, export: { ...s.export, csv: !s.export.csv } }) },
      { id: "output-tab", group: "Output", label: "Output › Color, timecode, JPEG quality", keywords: "rec709 srgb chroma", run: goto("output") },
      { id: "sheet-tab", group: "Output", label: "Output › Contact sheet settings", keywords: "pdf columns page", run: goto("output") },
      ...TABS.map(([t, l]): Command => ({ id: `tab-${t}`, group: "Go to", label: `${l[0]}${l.slice(1).toLowerCase()} tab`, value: tab === t ? "Current" : undefined, run: goto(t) })),
      ...SKINS.map((k): Command => ({
        id: `skin-${k.id}`, group: "Appearance", label: `Skin: ${k.name}`, value: s.ui.skin === k.id ? "Current" : k.note, keywords: "theme look colors",
        run: () => setUi({ skin: k.id }),
      })),
      { id: "theme", group: "Appearance", label: s.ui.theme === "dark" ? "Light theme" : "Dark theme", disabled: s.ui.skin !== "studio", value: s.ui.skin !== "studio" ? "Studio skin only" : undefined, run: () => setUi({ theme: s.ui.theme === "dark" ? "light" : "dark" }) },
      { id: "effects", group: "Appearance", label: "Skin decoration", value: onOff(s.ui.effects), run: () => setUi({ effects: !s.ui.effects }) },
      { id: "prefs", group: "App", label: "Preferences", shortcut: shortcut(","), keywords: "settings options", run: () => openPrefs("appearance") },
      { id: "decoder", group: "App", label: "Analysis decoder", value: s.shots.decoder === "auto" ? "Auto" : s.shots.decoder.toUpperCase(), keywords: "gpu cpu nvdec videotoolbox", run: () => openPrefs("analysis") },
      { id: "updates", group: "App", label: "Check for updates", disabled: appInfo ? !appInfo.updatesEnabled : false, run: () => { openPrefs("updates"); void checkUpdate(); } },
      { id: "projects", group: "App", label: "Saved projects and analyses", keywords: "cache clear disk", run: () => openPrefs("projects") },
      { id: "shortcuts", group: "App", label: "Keyboard shortcuts", shortcut: "?", keywords: "help keys", run: () => setShortcutsOpen(true) },
      { id: "about", group: "App", label: "About Photogramme and licenses", run: () => openPrefs("about") },
      { id: "repo", group: "App", label: "Source code on GitHub", run: () => void api.openLink("repo").catch(fail) },
      { id: "issues", group: "App", label: "Report a problem", keywords: "bug issue", run: () => void api.openLink("issues").catch(fail) },
    ];
    if (appInfo?.kofi) list.push({ id: "kofi", group: "App", label: "Buy me a coffee on Ko-fi", keywords: "support donate", run: () => void api.openLink("kofi").catch(fail) });
    return list;
  }, [settings, info, tabs.active, player.playing, player.frameRef, marks, compare, preview, scopesOpen, zoom, analysis, job, output, plan.count, muted, toggleMute,
    shots.length, removedCuts.size, addedCuts.size, presets, tab, appInfo, newTab, closeTab, togglePlay, seek, cutHere, capture, setReference,
    setUi, analyze, importCuts, changeSettings, exportBatch, cancelJob, exportBarcode, setAll, resetEdits, savePalette, fail, chooseDir,
    openPrefs, checkUpdate]);

  return (
    <div className="app">
      <TopBar tabs={tabs} switching={switching} onSelect={(k) => void switchTab(k)} onClose={(k) => void closeTab(k)} onNew={() => void newTab()}
        theme={shownTheme} onTheme={settings && settings.ui.skin === "studio" ? (t) => setUi({ theme: t }) : null}
        onCommands={() => setPaletteOpen(true)} onPreferences={() => openPrefs()} />
      <div className="skin-decor" aria-hidden />
      {banner && (
        <UpdateBanner update={banner} progress={installing} onInstall={() => void installUpdate()} onLater={() => setBanner(null)}
          onSkip={() => {
            if (settings && banner.version) changeSettings({ ...settings, updates: { ...settings.updates, skipped: banner.version } });
            setBanner(null);
          }} />
      )}
      {info && !warningsHidden && <Warnings items={info.warnings} onDismiss={() => setWarningsHidden(true)} />}
      <div className="body">
        <main className="main">
          {info ? (
            <>
              <div className="viewer-row">
                <div className="viewer-col">
                  <Viewer info={info} videoRef={player.videoRef} preview={preview}
                    previewSize={previewSize} previewState={previewState} onTogglePreview={() => setPreview((p) => !p)}
                    zoom={zoom} onZoom={setZoom} compare={compare} onSplit={(split) => setCompare((c) => (c ? { ...c, split } : c))}
                    onToggleCompare={() => setCompare((c) => (c ? { ...c, on: !c.on } : c))} onSetReference={() => void setReference()}
                    scopesOpen={scopesOpen} onToggleScopes={() => setUi({ scopesOpen: !scopesOpen })}
                    cors={cors} onCorsFailed={() => {
                      setCors(false);
                      setSync({ status: "unavailable", tries: 4 });
                    }}>
                    <canvas ref={canvasRef} className="preview-canvas" data-frame={still?.frame} data-exact={still && !still.provisional ? "" : undefined}
                      style={{ display: preview && previewSize && !player.playing ? "block" : "none" }} />
                    {preview && settings && !settings.export.overlay && !player.playing && (
                      <div className="preview-note">LOOK OFF IN EXPORTS · turn on “Apply the look to exported stills” (LOOK)</div>
                    )}
                  </Viewer>
                  <Transport info={info} frame={player.frame} marks={marks} muted={muted} onMute={toggleMute} playing={player.playing} shuttle={player.shuttleSpeed} busy={busy}
                    onTogglePlay={player.togglePlay} onStep={player.step} onCapture={() => void capture()}
                    onMarkIn={() => setMarks((m) => ({ start: player.frameRef.current, end: m.end != null && m.end < player.frameRef.current ? null : m.end }))}
                    onMarkOut={() => setMarks((m) => ({ start: m.start != null && m.start > player.frameRef.current ? null : m.start, end: player.frameRef.current }))}
                    onClearMarks={() => setMarks({ start: null, end: null })} />
                </div>
                {scopesOpen && settings && (
                  <ScopesPanel kind={settings.ui.scope} data={still} loading={stillLoading} playing={player.playing}
                    onKind={(scope: ScopeKind) => setUi({ scope })} onClose={() => setUi({ scopesOpen: false })} />
                )}
              </div>
              <TimelinePanel strip={settings?.ui.strip ?? "barcode"} onStrip={(strip) => setUi({ strip })} hasAnalysis={!!analysis}>
                {analysis && settings && (
                  <BarcodeStrip analysisId={analysis.id} mode={settings.barcode.mode} strip={settings.ui.strip ?? "barcode"}
                    frames={info.frameCount} onSeek={player.seek} />
                )}
                <Timeline info={info} frame={player.frame} markers={markers} cuts={cuts} manualCuts={manualCuts} range={marks} onSeek={player.seek} />
              </TimelinePanel>
            </>
          ) : (
            <EmptyState onOpen={() => void openDialog()} dragging={dragging} />
          )}
        </main>
        <aside className="side panel-box" aria-label="Inspector">
          <nav className="tabs" role="tablist" aria-label="Panels">
            {TABS.map(([t, l]) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
                {l}{t === "gallery" && captures.length > 0 && <span className="tab-count">{captures.length}</span>}
              </button>
            ))}
          </nav>
          <div className="side-body">
            {tab === "extract" && (info && settings ? (
              <ExtractPanel info={info} settings={settings} analysis={analysis} source={source} imported={imported}
                shots={shots} currentShot={currentShot} job={job} plannedCount={plan.count} planError={plan.error}
                range={range} output={output} sheetPages={sheetPages} manualCount={addedCuts.size}
                onOutput={setOutput} onSource={setSource} onImport={() => void importCuts()} onClearImport={clearImport}
                onChange={changeSettings} onAnalyze={() => void analyze()} onToggle={toggleShot} onMerge={mergeShot}
                onSetAll={setAll} onResetEdits={resetEdits} onCutHere={cutHere} onSeek={player.seek}
                onClearRange={() => setMarks({ start: null, end: null })} onExport={() => void exportBatch()}
                onCancel={cancelJob} onExportBarcode={() => void exportBarcode()} />
            ) : (
              <p className="muted">Open a film to extract frames by shot, by interval or spread over the film.</p>
            ))}
            {tab === "gallery" && (
              <GalleryPanel captures={captures} reference={compare ? compare.ref.timecode : null} onSeek={player.seek}
                onReveal={(p) => api.reveal(p).catch(fail)} onSavePalette={() => void savePalette()} onSetReference={() => void setReference()} />
            )}
            {tab === "look" && settings && (
              <LookPanel settings={settings} presets={presets} layer={lookLayer} onLayer={setLookLayer} onChange={changeSettings}
                onSavePreset={(p) => api.savePreset(p).then(setPresets).then(() => setToast({ kind: "ok", text: `Preset "${p.name}" saved` })).catch(fail)}
                onDeletePreset={(n) => api.deletePreset(n).then(setPresets).catch(fail)}
                onOpenPresets={() => api.openPresetsFolder().catch(fail)} />
            )}
            {tab === "output" && settings && (
              <OutputPanel settings={settings} onChange={changeSettings} onPickDir={() => void chooseDir()}
                onOpenDir={() => void api.openFolder().catch(fail)} onExportBarcode={() => void exportBarcode()} canExportBarcode={!!analysis} />
            )}
          </div>
        </aside>
      </div>
      <StatusBar info={info} analyzedWith={analysis?.decoder ?? null} syncNote={syncNote} onShortcuts={() => setShortcutsOpen(true)} />
      {settings && (
        <PrefsDialog open={prefs.open} section={prefs.section} onSection={(section) => setPrefs({ open: true, section })}
          onClose={() => setPrefs((p) => ({ ...p, open: false }))} settings={settings} appInfo={appInfo} update={update}
          onChange={changeSettings} onCheckUpdate={() => void checkUpdate()} onOpenLink={(l) => api.openLink(l).catch(fail)} />
      )}
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toast toast={toast} onClose={closeToast} onError={fail} />
    </div>
  );
}
