import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as RPointerEvent, ReactNode, RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, nearThumbUrl } from "./api";
import { FILE_MANAGER, GPU_NAME, shortcut } from "./platform";
import { useFitBox, useWidth } from "./hooks";
import { drawScope, scopeAspect } from "./scopes";
import { formatBytes, formatFps, frameToTc, tcOf } from "./timecode";
import type { BarcodeMode, StripMode, CaptureResult, FrameData, FrameRange, ScopeKind, TabsView, Theme, UpdateInfo, VideoInfo } from "./types";
import {
  IconBackSecond, IconCamera, IconFwdSecond, IconLogo, IconNextFrame,
  IconFolder, IconMoon, IconPause, IconPlay, IconPrevFrame, IconReveal, IconSun, IconWarning,
} from "./icons";

/* ───────────── Barre du haut ───────────── */

export function TopBar({ info, onOpen, theme, onTheme }: {
  info: VideoInfo | null; onOpen: () => void; theme: Theme; onTheme: (t: Theme) => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="accent"><IconLogo /></span>
        <span className="brand-name">PHOTOGRAMME</span>
      </div>
      {info && (
        <div className="meta">
          <span className="meta-file" title={info.path}>{info.fileName}</span>
          <span title={info.outWidth !== info.width || info.outHeight !== info.height ? `Coded ${info.width}×${info.height}` : undefined}>
            {info.outWidth}×{info.outHeight}
          </span>
          <span>{formatFps(info.fps)}</span>
          <span title="Start timecode">TC {tcOf(info, 0)}</span>
          <span>Duration {frameToTc(info.frameCount, info.fps)}</span>
          <span className={info.nvdecCompatible ? "meta-gpu" : "meta-cpu"}
            title={info.nvdecCompatible ? `Decodable by the GPU (${GPU_NAME})` : "CPU decoding"}>
            {info.nvdecCompatible ? GPU_NAME : "CPU decoding"}
          </span>
        </div>
      )}
      <div className="topbar-actions">
        <button type="button" className="btn-theme" onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}>
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
        <button className="btn-ghost" onClick={onOpen}>OPEN</button>
      </div>
    </header>
  );
}

/** Onglets : un par film récent. Un seul film est chargé ; changer d'onglet le recharge depuis son projet. */
export function TabBar({ tabs, switching, onSelect, onClose, onNew }: {
  tabs: TabsView; switching: string | null;
  onSelect: (key: string) => void; onClose: (key: string) => void; onNew: () => void;
}) {
  if (!tabs.tabs.length) return null;
  return (
    <nav className="filmtabs" aria-label="Films">
      <div className="filmtabs-list" role="tablist">
        {tabs.tabs.map((t) => {
          const active = t.key === tabs.active;
          return (
            <div key={t.key} role="tab" aria-selected={active} tabIndex={0}
              className={`filmtab${active ? " is-active" : ""}${t.missing ? " is-missing" : ""}${switching === t.key ? " is-loading" : ""}`}
              title={t.missing ? `File not found: ${t.folder}` : `${t.fileName}\n${t.folder}`}
              onClick={() => !active && onSelect(t.key)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !active) {
                  e.preventDefault();
                  onSelect(t.key);
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.key);
                }
              }}>
              <span className="filmtab-name">{t.fileName}</span>
              <button type="button" className="filmtab-close" aria-label={`Close ${t.fileName}`} title="Close the tab (the project is kept)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.key);
                }}>×</button>
            </div>
          );
        })}
      </div>
      <button type="button" className="filmtab-new" onClick={onNew} aria-label="Open a film in a new tab" title={`Open a film (${shortcut("O")})`}>+</button>
    </nav>
  );
}

export function Warnings({ items, onDismiss }: { items: string[]; onDismiss: () => void }) {
  if (!items.length) return null;
  return (
    <div className="warnings" role="status">
      <IconWarning />
      <ul>{items.map((w) => <li key={w}>{w}</li>)}</ul>
      <button className="btn-link" onClick={onDismiss}>Hide</button>
    </div>
  );
}

/** Mise à jour disponible : installer, plus tard, ou ignorer cette version. */
export function UpdateBanner({ update, progress, onInstall, onLater, onSkip }: {
  update: UpdateInfo; progress: { done: number; total: number | null; installing: boolean } | null;
  onInstall: () => void; onLater: () => void; onSkip: () => void;
}) {
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="update-banner" role="status">
      <strong>Photogramme {update.version} is available</strong>
      <span className="muted small">You have {update.current}.</span>
      {update.notes && <span className="update-notes small" title={update.notes}>{update.notes.split("\n").find((l) => l.trim()) ?? ""}</span>}
      {progress ? (
        <span className="small mono">{progress.installing ? "Installing… the app will restart" : `Downloading${pct != null ? ` ${pct} %` : "…"}`}</span>
      ) : (
        <span className="row push">
          <button type="button" className="btn-small btn-accent" onClick={onInstall}>Install and restart</button>
          <button type="button" className="btn-small" onClick={onLater}>Later</button>
          <button type="button" className="btn-link small" onClick={onSkip}>Skip this version</button>
        </span>
      )}
    </div>
  );
}

/* ───────────── État vide ───────────── */

export function EmptyState({ onOpen, dragging }: { onOpen: () => void; dragging: boolean }) {
  return (
    <div className={`empty ${dragging ? "is-dragging" : ""}`}>
      <div className="empty-frame">
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />
        <p className="empty-title">{dragging ? "DROP THE FILM HERE" : "NO FILM LOADED"}</p>
        <p className="empty-sub">H.264 files · mp4, mov, m4v, mkv</p>
        <button className="btn-primary" onClick={onOpen}>OPEN A FILM</button>
        <p className="empty-hint">or drop a file onto the window</p>
      </div>
    </div>
  );
}

/* ───────────── Visionneuse ───────────── */

export type Zoom = "fit" | 1 | 2;

/** Référence A/B : image exacte figée, comparée en volet à l'image courante. */
export interface Compare {
  ref: FrameData;
  on: boolean;
  split: number;
}

/** Taille de la composition affichée dans l'aperçu et place de l'image du film dedans. */
export interface PreviewSize {
  w: number;
  h: number;
  image: { x: number; y: number; w: number; h: number };
}

/**
 * Découpe du volet A/B : la position du volet est en fraction de la boîte
 * entière ; convertie ici en fraction du canvas de référence, qui peut ne
 * couvrir que la zone image de la composition.
 */
function refClip(split: number, p: PreviewSize | null): string {
  let right = 1 - split;
  if (p) {
    const edge = (split * p.w - p.image.x) / p.image.w;
    right = 1 - Math.min(1, Math.max(0, edge));
  }
  return `inset(0 ${right * 100}% 0 0)`;
}

/** Dessine une image exacte sur un canvas (taille native). */
function useImageCanvas(ref: RefObject<HTMLCanvasElement | null>, data: FrameData | null) {
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    c.width = data.width;
    c.height = data.height;
    c.getContext("2d")?.putImageData(new ImageData(data.rgba as Uint8ClampedArray<ArrayBuffer>, data.width, data.height), 0, 0);
  }, [ref, data]);
}

/**
 * Lecture : la balise <video>. Aperçu d'export : un Canvas qui reçoit la
 * composition exacte (mêmes pixels et même code que le fichier exporté).
 * Zoom : « fit », 100 % (un pixel du film = un pixel de l'écran) ou 200 %,
 * déplacement à la souris. Comparaison A/B : volet glissant.
 */
export function Viewer({ info, videoRef, frame, preview, previewSize, previewState, onTogglePreview, zoom, onZoom,
  compare, onSplit, onToggleCompare, onCorsFailed, cors, children }: {
  info: VideoInfo;
  videoRef: RefObject<HTMLVideoElement | null>;
  frame: number;
  preview: boolean;
  previewSize: PreviewSize | null;
  previewState: "idle" | "loading" | "ready" | "playing";
  onTogglePreview: () => void;
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  compare: Compare | null;
  onSplit: (s: number) => void;
  onToggleCompare: () => void;
  onCorsFailed: () => void;
  cors: boolean;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const refCanvas = useRef<HTMLCanvasElement>(null);
  const showCanvas = preview && previewSize !== null && previewState !== "playing";
  const nativeW = showCanvas ? previewSize.w : info.outWidth;
  const nativeH = showCanvas ? previewSize.h : info.outHeight;
  const fit = useFitBox(stage, nativeW / nativeH);
  const dpr = window.devicePixelRatio || 1;
  const box = zoom === "fit" ? fit : { w: Math.round((nativeW * zoom) / dpr), h: Math.round((nativeH * zoom) / dpr) };
  // Redessinée à chaque réaffichage du volet (le canvas est recréé quand on le rallume).
  useImageCanvas(refCanvas, compare?.on ? compare.ref : null);
  // Avec l'aperçu d'export, la référence A est posée sur la zone de l'image du film
  // dans la composition (pas sur les marges ni la bande) : même échelle, même place.
  const refStyle: CSSProperties = showCanvas
    ? {
        left: `${(previewSize.image.x / previewSize.w) * 100}%`,
        top: `${(previewSize.image.y / previewSize.h) * 100}%`,
        width: `${(previewSize.image.w / previewSize.w) * 100}%`,
        height: `${(previewSize.image.h / previewSize.h) * 100}%`,
      }
    : {};

  // Déplacement de l'image zoomée à la souris.
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (zoom === "fit" || !stage.current || (e.target as HTMLElement).closest(".wipe-handle")) return;
    drag.current = { x: e.clientX, y: e.clientY, sl: stage.current.scrollLeft, st: stage.current.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !stage.current) return;
    stage.current.scrollLeft = d.sl - (e.clientX - d.x);
    stage.current.scrollTop = d.st - (e.clientY - d.y);
  };
  // Zoom : on garde le centre de l'image au centre de la vue.
  useLayoutEffect(() => {
    const s = stage.current;
    if (!s || zoom === "fit") return;
    s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
    s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
  }, [zoom, nativeW, nativeH]);

  // Volet A/B.
  const wipe = useRef<HTMLDivElement>(null);
  const onWipe = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 && e.type !== "pointerdown") return;
    const r = wipe.current?.getBoundingClientRect();
    if (!r) return;
    onSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  const zooms: [Zoom, string][] = [["fit", "FIT"], [1, "100%"], [2, "200%"]];

  return (
    <section className="viewer" aria-label="Viewer">
      <div className="viewer-hud">
        <span>TC {tcOf(info, frame)}</span>
        <span className="hud-group">
          <button type="button" className={`hud-toggle ${preview ? "on" : ""}`} aria-pressed={preview} onClick={onTogglePreview}
            title="Shows the exact exported image (P)">
            EXPORT PREVIEW <kbd>P</kbd>
            {preview && previewState === "loading" && <span className="dot" aria-label="loading" />}
          </button>
          {compare && (
            <button type="button" className={`hud-toggle ${compare.on ? "on" : ""}`} aria-pressed={compare.on} onClick={onToggleCompare}
              title={`Reference ${compare.ref.timecode} on the left of the wipe (W). R sets a new reference.`}>
              A/B <kbd>W</kbd>
            </button>
          )}
          <span className="zoom-pills" role="group" aria-label="Zoom">
            {zooms.map(([z, l]) => (
              <button key={String(z)} type="button" className="hud-toggle" aria-pressed={zoom === z} onClick={() => onZoom(z)}
                title="Z cycles the zoom">{l}</button>
            ))}
          </span>
        </span>
        <span>FRAME {String(frame).padStart(6, "0")}</span>
      </div>
      <div className={`viewer-stage ${zoom === "fit" ? "" : "is-zoomed"}`} ref={stage}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)}>
        <div className="viewer-box" style={{ width: box.w, height: box.h }} ref={wipe}>
          <video
            key={cors ? "cors" : "plain"}
            ref={videoRef}
            src={convertFileSrc(info.path)}
            crossOrigin={cors ? "anonymous" : undefined}
            preload="auto"
            playsInline
            disablePictureInPicture
            onError={() => cors && onCorsFailed()}
            onContextMenu={(e) => e.preventDefault()}
            style={{ visibility: showCanvas ? "hidden" : "visible" }}
          />
          {children}
          {compare?.on && (
            <>
              <canvas ref={refCanvas} className="ref-canvas" style={{ ...refStyle, clipPath: refClip(compare.split, showCanvas ? previewSize : null) }} />
              <div className="wipe-handle" style={{ left: `${compare.split * 100}%` }}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onWipe(e); }} onPointerMove={onWipe}
                role="slider" aria-label="A/B wipe position" aria-valuenow={Math.round(compare.split * 100)} tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") onSplit(Math.max(0, compare.split - 0.05));
                  if (e.key === "ArrowRight") onSplit(Math.min(1, compare.split + 0.05));
                }}>
                <span className="wipe-label a">A {compare.ref.timecode}</span>
                <span className="wipe-label b">B</span>
              </div>
            </>
          )}
          {!compare?.on && !showCanvas && zoom === "fit" && (
            <>
              <span className="corner tl" /><span className="corner tr" />
              <span className="corner bl" /><span className="corner br" />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ───────────── Scopes ───────────── */

const SCOPES: [ScopeKind, string][] = [["waveform", "WAVE"], ["parade", "PARADE"], ["vectorscope", "VECTOR"], ["histogram", "HISTO"]];

/** Panneau des instruments, calculés sur l'image exacte arrêtée. */
export function ScopesPanel({ kind, data, loading, playing, onKind, onClose }: {
  kind: ScopeKind; data: FrameData | null; loading: boolean; playing: boolean;
  onKind: (k: ScopeKind) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(w * scopeAspect(kind));
    c.width = w;
    c.height = h;
    c.style.height = `${h / dpr}px`;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    drawScope(ctx, kind, { rgba: data.rgba, width: data.width, height: data.height }, { x: 0, y: 0, w, h }, 1);
  }, [kind, data, width]);
  return (
    <aside className="scopes" aria-label="Scopes">
      <div className="row-between">
        <div className="pills scope-pills" role="group" aria-label="Scope">
          {SCOPES.map(([k, l]) => (
            <button key={k} type="button" className="pill" aria-pressed={kind === k} onClick={() => onKind(k)}>{l}</button>
          ))}
        </div>
        <button type="button" className="btn-mini" aria-label="Close the scopes (S)" title="S" onClick={onClose}>×</button>
      </div>
      <div className="scope-canvas" ref={wrap}>
        <canvas ref={ref} />
        {(playing || !data) && (
          <p className="scope-note small">{playing ? "Paused frames only: the scopes read the exact exported pixels." : loading ? "Reading the frame…" : "Pause on a frame."}</p>
        )}
      </div>
      {data && <p className="small muted mono">{data.timecode} · {data.width}×{data.height}</p>}
    </aside>
  );
}

/* ───────────── Transport ───────────── */

export function Transport({ info, frame, playing, shuttle, busy, onTogglePlay, onStep, onCapture, onMarkIn, onMarkOut }: {
  info: VideoInfo; frame: number; playing: boolean; shuttle: number; busy: boolean;
  onTogglePlay: () => void; onStep: (d: number) => void; onCapture: () => void; onMarkIn: () => void; onMarkOut: () => void;
}) {
  const sec = Math.round(info.fps);
  return (
    <section className="transport" aria-label="Playback and capture">
      <div className="tc-block">
        <span className="tc-big">{tcOf(info, frame)}</span>
        <span className="tc-sub">FRAME {frame + 1} / {info.frameCount}{shuttle !== 0 && shuttle !== 1 ? `  ·  ${shuttle > 0 ? "▶" : "◀"} ×${Math.abs(shuttle)}` : ""}</span>
      </div>
      <div className="transport-buttons">
        <button className="btn-icon btn-mark" aria-label="Mark in" title="Mark in (I)" onClick={onMarkIn}>I</button>
        <button className="btn-icon" aria-label="Back one second" title="Shift + ←" onClick={() => onStep(-sec)}><IconBackSecond /></button>
        <button className="btn-icon" aria-label="Previous frame" title="←" onClick={() => onStep(-1)}><IconPrevFrame /></button>
        <button className="btn-play" aria-label={playing ? "Pause" : "Play"} title="Space · J/K/L shuttle" onClick={onTogglePlay}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="btn-icon" aria-label="Next frame" title="→" onClick={() => onStep(1)}><IconNextFrame /></button>
        <button className="btn-icon" aria-label="Forward one second" title="Shift + →" onClick={() => onStep(sec)}><IconFwdSecond /></button>
        <button className="btn-icon btn-mark" aria-label="Mark out" title="Mark out (O)" onClick={onMarkOut}>O</button>
      </div>
      <button className="btn-capture" onClick={onCapture} disabled={busy} aria-busy={busy}>
        <IconCamera />
        {busy ? "EXTRACTING…" : "CAPTURE"}
        <kbd>C</kbd>
      </button>
    </section>
  );
}

/* ───────────── Code-barre ───────────── */

/** Bande au-dessus de la timeline : code-barre couleur ou vignettes du film.
 *  Un clic positionne la lecture ; le sélecteur à droite change le contenu ou masque la bande. */
export const BarcodeStrip = memo(function BarcodeStrip({ analysisId, mode, strip, frames, onSeek, onStrip }: {
  analysisId: number; mode: BarcodeMode; strip: StripMode; frames: number;
  onSeek: (f: number) => void; onStrip: (s: StripMode) => void;
}) {
  // Mesure sur un conteneur toujours présent : la largeur reste connue quand on masque puis réaffiche la bande.
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (strip !== "barcode" || width <= 0) return;
    let alive = true;
    let made: string | null = null;
    const w = Math.min(4096, Math.round(width * (window.devicePixelRatio || 1)));
    api.barcodePreview(w, 64, mode).then((blob) => {
      if (!alive) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [analysisId, mode, width, strip]);
  // Une vignette 16:9 par case de 36 px de haut, centrée sur sa portion du film.
  const tiles = strip === "frames" && width > 0 ? Math.max(1, Math.round(width / 64)) : 0;
  const centers = Array.from({ length: tiles }, (_, i) => Math.round(((i + 0.5) / tiles) * Math.max(0, frames - 1)));
  const options: [StripMode, string][] = [["barcode", "COLORS"], ["frames", "FRAMES"], ["off", "OFF"]];
  return (
    <div className="strip">
      <div className="strip-track" ref={ref}>
      {strip !== "off" && (
        <button type="button" className={`barcode${strip === "frames" ? " filmstrip" : ""}`}
          aria-label={strip === "frames" ? "Film frames: click to jump" : "Film barcode: click to jump"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.round(((e.clientX - r.left) / r.width) * (frames - 1)));
          }}>
          {strip === "barcode" && url && <img src={url} alt="" draggable={false} />}
          {centers.map((f, i) => (
            <img key={`${i}-${f}`} src={nearThumbUrl(analysisId, f)} alt="" draggable={false} loading="lazy" decoding="async" />
          ))}
        </button>
      )}
      </div>
      <div className="pills strip-switch" role="group" aria-label="Strip above the timeline">
        {options.map(([v, l]) => (
          <button key={v} type="button" className="pill" aria-pressed={strip === v} onClick={() => onStrip(v)}
            title={v === "off" ? "Hide the strip" : v === "frames" ? "Show frames from the film" : "Show the color barcode"}>{l}</button>
        ))}
      </div>
    </div>
  );
});

/* ───────────── Timeline ───────────── */

export function Timeline({ info, frame, markers, cuts, manualCuts, range, onSeek }: {
  info: VideoInfo; frame: number; markers: number[]; cuts: number[]; manualCuts: number[];
  range: { start: number | null; end: number | null }; onSeek: (f: number) => void;
}) {
  const max = Math.max(1, info.frameCount - 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => tcOf(info, Math.round(p * max)));
  const pct = (f: number) => `${(f / max) * 100}%`;
  const rs = range.start ?? 0;
  const re = range.end ?? max;
  const hasRange = range.start != null || range.end != null;
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-track">
        {hasRange && (
          <>
            <span className="range-out" style={{ left: 0, width: pct(rs) }} />
            <span className="range-out" style={{ left: pct(re), right: 0 }} />
            {range.start != null && <span className="range-mark in" style={{ left: pct(rs) }} />}
            {range.end != null && <span className="range-mark out" style={{ left: pct(re) }} />}
          </>
        )}
        {cuts.length > 0 && (
          <svg className="cuts" viewBox={`0 0 ${max} 1`} preserveAspectRatio="none" aria-hidden>
            <path d={cuts.map((c) => `M${c} 0V1`).join("")} />
          </svg>
        )}
        {manualCuts.length > 0 && (
          <svg className="cuts manual" viewBox={`0 0 ${max} 1`} preserveAspectRatio="none" aria-hidden>
            <path d={manualCuts.map((c) => `M${c} 0V1`).join("")} />
          </svg>
        )}
        {markers.map((m) => (
          <span key={m} className="marker" style={{ left: pct(m) }} />
        ))}
        <span className="playhead" style={{ left: pct(frame) }} />
        <input
          type="range" min={0} max={max} step={1} value={frame}
          aria-label="Position in the film"
          aria-valuetext={tcOf(info, frame)}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>
      <div className="timeline-ticks">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
    </section>
  );
}

/* ───────────── Captures ───────────── */

/** Au-delà, seules les dernières captures sont affichées (le DOM reste léger). */
const MAX_SHOWN = 240;

export function CapturesPanel({ captures, onSeek, onReveal, onSavePalette, onSetReference }: {
  captures: CaptureResult[]; onSeek: (f: number) => void; onReveal: (p: string) => void;
  onSavePalette: () => void; onSetReference: () => void;
}) {
  const last = captures[0];
  return (
    <section className="panel" aria-label="Captures">
      <h2>CAPTURES <span className="count">({captures.length})</span></h2>
      <div className="row wrap">
        <button type="button" className="btn-small" onClick={onSavePalette} title="Writes .ase (Adobe, Affinity), .css, .gpl (GIMP, Krita) and .json files">
          Save this frame's palette
        </button>
        <button type="button" className="btn-small" onClick={onSetReference} title="R">Set as A/B reference</button>
      </div>
      {last && <p className="small muted">Last: {formatBytes(last.bytes)} · {last.width}×{last.height}{last.fileName.endsWith(".png") ? " · PNG" : ` · q${last.quality}`}</p>}
      {captures.length === 0 ? (
        <p className="muted">Press <kbd>C</kbd> to capture the displayed frame.</p>
      ) : (
        <div className="thumbs">
          {captures.slice(0, MAX_SHOWN).map((c) => (
            <figure key={c.path} className="thumb">
              <button className="thumb-img" onClick={() => onSeek(c.frame)} aria-label={`Go back to ${c.timecode}`}>
                <img src={convertFileSrc(c.path)} alt="" loading="lazy" decoding="async" />
              </button>
              <figcaption>
                <span>{c.shot != null ? `#${c.shot} · ` : ""}{c.timecode}</span>
                <button className="btn-mini" aria-label={`Show ${c.fileName} in ${FILE_MANAGER}`} onClick={() => onReveal(c.path)}>
                  <IconReveal size={14} />
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {captures.length > MAX_SHOWN && <p className="small muted">{captures.length - MAX_SHOWN} older captures not shown.</p>}
    </section>
  );
}

/* ───────────── Notification ───────────── */

/** `show` : fichier à montrer dans l'Explorateur, ou dossier à ouvrir (`folder`). */
export type ToastState = { kind: "ok" | "error"; text: string; show?: { path: string; folder?: boolean } } | null;

export function Toast({ toast, onClose, onError }: { toast: ToastState; onClose: () => void; onError?: (e: unknown) => void }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!toast || hover) return;
    // Plus long quand il y a un bouton, et en pause tant que la souris est dessus.
    const t = setTimeout(onClose, toast.kind === "error" ? 8000 : toast.show ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [toast, onClose, hover]);
  if (!toast) return null;
  const show = toast.show;
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className="toast-text">{toast.text}</span>
      {show && (
        <button type="button" className="btn-small toast-action" onClick={() => {
          (show.folder ? api.openFolder(show.path) : api.reveal(show.path)).then(onClose, (e) => onError?.(e));
        }}>
          <IconFolder /> {show.folder ? "Open folder" : "Show in folder"}
        </button>
      )}
      <button className="btn-link" onClick={onClose} aria-label="Close">×</button>
    </div>
  );
}

/** Plage de travail (points d'entrée et de sortie) pour l'export. */
export function rangeOf(r: { start: number | null; end: number | null }, frameCount: number): FrameRange | null {
  if (r.start == null && r.end == null) return null;
  const start = Math.max(0, r.start ?? 0);
  const end = Math.min(frameCount - 1, r.end ?? frameCount - 1);
  return end >= start ? { start, end } : null;
}
