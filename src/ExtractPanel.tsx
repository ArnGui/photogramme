// Onglet « Extract » : extraction par plans (détectés ou importés d'une
// liste de montage), par intervalle ou N images réparties ; liste des plans,
// coupes ajoutées à la main, export en images ou en planche contact.

import { memo, useEffect, useRef, useState } from "react";
import { thumbUrl } from "./api";
import { Choice, NumberField } from "./fields";
import { GPU_NAME } from "./platform";
import type { DisplayShot } from "./shotlist";
import { frameToTc, tcOf } from "./timecode";
import type { AnalysisSummary, BatchMode, FrameRange, ImportedCuts, Pick, Settings, ShotSource, VideoInfo } from "./types";

/** Réglages du mode « par plan » ouverts ou repliés (confort de chaque poste). */
const OPEN_KEY = "photogramme.extractSettingsOpen";

export function PickField({ pick, onChange }: { pick: Pick; onChange: (p: Pick) => void }) {
  const count = pick.mode === "spread" ? pick.count : 3;
  return (
    <>
      <Choice
        label="FRAME KEPT PER SHOT"
        value={pick.mode}
        options={[["first", "First"], ["middle", "Middle"], ["last", "Last"], ["spread", "N per shot"]]}
        onChange={(m) => onChange(m === "spread" ? { mode: "spread", count } : { mode: m })}
      />
      {pick.mode === "spread" && (
        <NumberField label="Frames per shot" value={count} min={1} max={20}
          onChange={(c) => onChange({ mode: "spread", count: Math.round(c) })} />
      )}
    </>
  );
}

export interface JobState {
  kind: "analysis" | "export" | "sheet";
  phase: string;
  done: number;
  total: number;
  startedAt: number;
}

export type Output = "stills" | "sheet";

function phaseLabel(phase: string) {
  if (phase === "analysis-gpu") return `Analyzing · GPU (${GPU_NAME})`;
  if (phase === "analysis-cpu") return "Analyzing · CPU";
  if (phase === "sheet") return "Laying out the contact sheet";
  return "Exporting";
}

export function Progress({ job, onCancel }: { job: JobState; onCancel: () => void }) {
  const pct = job.total > 0 ? Math.min(100, (job.done / job.total) * 100) : 0;
  const elapsed = (performance.now() - job.startedAt) / 1000;
  const eta = job.done > 0 && job.total > job.done ? (elapsed / job.done) * (job.total - job.done) : null;
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="row-between small">
        <span>{phaseLabel(job.phase)}</span>
        <span className="mono">{job.done.toLocaleString("en")} / {job.total.toLocaleString("en")}{eta != null && ` · ~${Math.ceil(eta)} s left`}</span>
      </div>
      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
      <button type="button" className="btn-small" onClick={onCancel}>Cancel</button>
    </div>
  );
}

const ShotRow = memo(function ShotRow({ shot, info, analysisId, isLast, active, onToggle, onMerge, onSeek }: {
  shot: DisplayShot; info: VideoInfo; analysisId: number | null; isLast: boolean; active: boolean;
  onToggle: (start: number) => void; onMerge: (index: number) => void; onSeek: (frame: number) => void;
}) {
  const len = shot.end - shot.start;
  return (
    <li className={`shot ${shot.checked ? "" : "is-off"} ${active ? "is-active" : ""}`}>
      <input type="checkbox" checked={shot.checked} aria-label={`Export shot ${shot.index}`} onChange={() => onToggle(shot.start)} />
      <button type="button" className="shot-thumb" onClick={() => onSeek(shot.start)} aria-label={`Go to shot ${shot.index}`}>
        {analysisId != null && shot.thumb != null
          ? <img src={thumbUrl(analysisId, shot.thumb)} alt="" loading="lazy" decoding="async" />
          : <span className="no-thumb" title="Analyze the film to see thumbnails">{tcOf(info, shot.start).slice(0, 8)}</span>}
      </button>
      <div className="shot-meta">
        <span className="shot-num">
          #{String(shot.index).padStart(3, "0")}
          {shot.parts > 1 && <em title={`${shot.parts} shots merged`}> ×{shot.parts}</em>}
          {shot.manual && <em title="Cut added by hand"> ✂</em>}
          <span className="muted" title={`${len} frames`}>{(len / info.fps).toFixed(1)} s</span>
        </span>
        <span className="shot-tc">
          <span title="In">{tcOf(info, shot.start)}</span>
          <span className="muted">→</span>
          <span title="Last frame of the shot">{tcOf(info, shot.end - 1)}</span>
        </span>
        {shot.clip && <span className="shot-clip" title={shot.clip}>{shot.clip}</span>}
      </div>
      {!isLast && (
        <button type="button" className="btn-mini shot-merge" title="Merge with the next shot (removes the cut)"
          aria-label={`Merge shot ${shot.index} with the next one`} onClick={() => onMerge(shot.index - 1)}>⤓</button>
      )}
    </li>
  );
});

export function ExtractPanel(props: {
  info: VideoInfo;
  settings: Settings;
  analysis: AnalysisSummary | null;
  source: ShotSource;
  imported: ImportedCuts | null;
  shots: DisplayShot[];
  currentShot: number;
  job: JobState | null;
  plannedCount: number | null;
  planError: string | null;
  range: FrameRange | null;
  output: Output;
  sheetPages: number | null;
  manualCount: number;
  onOutput: (o: Output) => void;
  onSource: (s: ShotSource) => void;
  onImport: () => void;
  onClearImport: () => void;
  onChange: (s: Settings) => void;
  onAnalyze: () => void;
  onToggle: (start: number) => void;
  onMerge: (index: number) => void;
  onSetAll: (checked: boolean | "invert") => void;
  onResetEdits: () => void;
  onCutHere: () => void;
  onSeek: (frame: number) => void;
  onClearRange: () => void;
  onExport: () => void;
  onCancel: () => void;
  onExportBarcode: () => void;
}) {
  const { info, settings: s, analysis, shots, job, onChange, source, imported } = props;
  const mode = s.batch.mode;
  const setMode = (m: BatchMode) => onChange({ ...s, batch: { ...s.batch, mode: m } });
  const edited = shots.some((x) => x.parts > 1) || props.manualCount > 0;
  const checked = shots.filter((x) => x.checked).length;
  const haveList = source === "imported" ? imported !== null : analysis !== null;

  // Le plan courant reste visible pendant la lecture.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current?.children[props.currentShot] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [props.currentShot]);

  const [settingsOpen, setSettingsOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const saveSettingsOpen = (open: boolean) => {
    setSettingsOpen(open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* stockage indisponible : l'état vaut pour la session */
    }
  };
  const pick = s.shots.pick;
  const settingsSummary = [
    source === "imported" ? "Edit list" : `Detection · ${s.shots.threshold} · ${s.shots.minSeconds} s`,
    pick.mode === "spread" ? `${pick.count} per shot` : pick.mode,
  ].join(" · ");

  const [showNote, setShowNote] = useState(true);
  useEffect(() => setShowNote(true), [analysis?.id, imported]);

  const busy = job !== null;
  const ext = s.export.format === "png" ? "PNG" : "JPEG";
  const exportLabel = props.output === "sheet"
    ? `Make the contact sheet${props.sheetPages ? ` · ${props.sheetPages} page${props.sheetPages > 1 ? "s" : ""}` : ""}`
    : `Export ${props.plannedCount ? `${props.plannedCount.toLocaleString("en")} ` : ""}${ext} still${props.plannedCount === 1 ? "" : "s"}`;

  return (
    <div className="extract">
      <div className="pills tabs-inner" role="tablist" aria-label="Extraction mode">
        {([["shots", "By shot"], ["interval", "Every X s"], ["spread", "N frames"]] as [BatchMode, string][]).map(([m, l]) => (
          <button key={m} type="button" role="tab" className="pill" aria-selected={mode === m} aria-pressed={mode === m}
            disabled={busy} onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>

      {mode === "shots" && (
        <>
          {/* Réglages repliables : la liste des plans passe devant. Toujours ouverts tant qu'il n'y a pas de liste. */}
          <details className="section extract-settings" open={settingsOpen || !haveList}
            onToggle={(e) => haveList && saveSettingsOpen(e.currentTarget.open)}>
            <summary title={settingsOpen || !haveList ? "Hide the settings" : "Show the settings"}>
              <span className="section-title">SETTINGS</span>
              <span className="section-summary mono">{settingsSummary}</span>
            </summary>
            <div className="section-body">
          <div className="field">
            <span className="label">CUTS FROM</span>
            <div className="pills" role="group" aria-label="Cuts from">
              <button type="button" className="pill" aria-pressed={source === "detect"} disabled={busy} onClick={() => props.onSource("detect")}>
                Detection
              </button>
              <button type="button" className="pill" aria-pressed={source === "imported"} disabled={busy}
                onClick={() => (imported ? props.onSource("imported") : props.onImport())}
                title="EDL, OTIO, FCP 7 XML or FCPXML exported from your edit">
                Edit list
              </button>
            </div>
          </div>

          {source === "imported" && (
            imported ? (
              <div className="imported small">
                <div className="row-between">
                  <span><strong>{imported.format}</strong> · <span className="mono">{imported.fileName}</span></span>
                  <span className="row">
                    <button type="button" className="btn-link" disabled={busy} onClick={props.onImport}>Replace</button>
                    <button type="button" className="btn-link" disabled={busy} onClick={props.onClearImport}>Remove</button>
                  </span>
                </div>
                <span className="muted">{imported.shots} shots from the edit{analysis ? "" : " · analyze the film for thumbnails"}</span>
                {imported.warnings.length > 0 && showNote && (
                  <div className="note">
                    <ul>{imported.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                    <button type="button" className="btn-link" onClick={() => setShowNote(false)}>OK</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="analyze-cta">
                <p className="muted small">
                  Import the cuts of your edit: an EDL (CMX 3600), an OpenTimelineIO file, a Final Cut Pro 7 XML or an FCPXML
                  exported from Resolve, Premiere or Final Cut. The cuts are then exact, no detection needed.
                </p>
                <button type="button" className="btn-primary" disabled={busy} onClick={props.onImport}>Import an edit list</button>
              </div>
            )
          )}

          {source === "detect" && !analysis && (
            <div className="analyze-cta">
              <p className="muted small">
                One pass over the whole film detects the cuts (FFmpeg <span className="mono">scdet</span>), builds the thumbnails and
                the color barcode. {info.nvdecCompatible ? `Decoded by the GPU (${GPU_NAME}) when available.` : "This file will be decoded on the CPU."}
              </p>
              <button type="button" className="btn-primary" disabled={busy} onClick={props.onAnalyze}>Analyze the film</button>
            </div>
          )}

          {analysis && (
            <p className="small muted analysis-line">
              {source === "detect" ? `${shots.length} shots · ` : ""}{analysis.seconds > 0
                ? `${analysis.decoder === "gpu" ? GPU_NAME : "CPU"} · ${analysis.seconds.toFixed(1)} s · ${(analysis.frames / analysis.seconds).toFixed(0)} fps`
                : "analysis from the saved project"}
              <button type="button" className="btn-link" disabled={busy} onClick={props.onAnalyze}>Re-analyze</button>
            </p>
          )}
          {source === "detect" && analysis?.note && showNote && (
            <p className="note small">{analysis.note} <button type="button" className="btn-link" onClick={() => setShowNote(false)}>OK</button></p>
          )}
          {source === "imported" && imported && !analysis && (
            <button type="button" className="btn-small" disabled={busy} onClick={props.onAnalyze}>Analyze for thumbnails and barcode</button>
          )}

          {haveList && (
            <>
              {source === "detect" && (
                <NumberField label="Threshold" value={s.shots.threshold} min={3} max={60} step={0.5}
                  onChange={(threshold) => onChange({ ...s, shots: { ...s.shots, threshold } })}
                  hint="Lower = more cuts. 10 is FFmpeg's default." />
              )}
              {source === "detect" && (
                <NumberField label="Minimum shot length" unit="s" value={s.shots.minSeconds} min={0} max={10} step={0.1}
                  onChange={(minSeconds) => onChange({ ...s, shots: { ...s.shots, minSeconds } })}
                  hint="Shorter shots are merged: ignores flashes and very fast cuts." />
              )}
              <PickField pick={s.shots.pick} onChange={(pick) => onChange({ ...s, shots: { ...s.shots, pick } })} />
            </>
          )}
            </div>
          </details>

          {haveList && (
            <>
              <div className="row list-tools small">
                <span className="muted">{checked}/{shots.length} selected</span>
                <button type="button" className="btn-link" onClick={() => props.onSetAll(true)}>All</button>
                <button type="button" className="btn-link" onClick={() => props.onSetAll(false)}>None</button>
                <button type="button" className="btn-link" onClick={() => props.onSetAll("invert")}>Invert</button>
                <button type="button" className="btn-link" onClick={props.onCutHere} title="Adds a cut at the playhead (B)">Cut here <kbd>B</kbd></button>
                {edited && <button type="button" className="btn-link" onClick={props.onResetEdits}>Undo edits</button>}
                {analysis && <button type="button" className="btn-link push" onClick={props.onExportBarcode} title="Saves the barcode as a JPEG in the output folder">Export barcode</button>}
              </div>
              <ol className="shots" ref={listRef}>
                {shots.map((sh, i) => (
                  <ShotRow key={sh.start} shot={sh} info={info} analysisId={analysis?.id ?? null} isLast={i === shots.length - 1}
                    active={i === props.currentShot} onToggle={props.onToggle} onMerge={props.onMerge} onSeek={props.onSeek} />
                ))}
              </ol>
            </>
          )}
        </>
      )}

      {mode === "interval" && (
        <NumberField label="One frame every" unit="s" value={s.batch.intervalSeconds} min={0.5} max={600} step={0.5}
          onChange={(intervalSeconds) => onChange({ ...s, batch: { ...s.batch, intervalSeconds } })} />
      )}
      {mode === "spread" && (
        <NumberField label="Frames spread over the film" value={s.batch.spreadCount} min={1} max={2000}
          onChange={(spreadCount) => onChange({ ...s, batch: { ...s.batch, spreadCount: Math.round(spreadCount) } })} />
      )}

      <div className="export-footer">
        {job ? (
          <Progress job={job} onCancel={props.onCancel} />
        ) : (
          <>
            {props.range && (
              <p className="small range-line">
                <span className="mono">In {tcOf(info, props.range.start)} · Out {tcOf(info, props.range.end)}</span>
                <span className="muted"> ({frameToTc(props.range.end - props.range.start + 1, info.fps)})</span>
                <button type="button" className="btn-link" onClick={props.onClearRange} title="Alt + X">Clear</button>
              </p>
            )}
            <div className="pills" role="group" aria-label="Output">
              <button type="button" className="pill" aria-pressed={props.output === "stills"} onClick={() => props.onOutput("stills")}>Stills</button>
              <button type="button" className="pill" aria-pressed={props.output === "sheet"} onClick={() => props.onOutput("sheet")}
                title="A printable grid of the frames with timecodes (Settings › Contact sheet)">Contact sheet</button>
            </div>
            <p className="small muted">
              {mode === "shots" && !haveList
                ? source === "imported" ? "Import an edit list to list its shots" : "Analyze the film to list its shots"
                : props.planError ?? (props.plannedCount != null ? `${props.plannedCount.toLocaleString("en")} frames` : "…")}
              {/* Plusieurs images par plan : le calcul est dit, le total n'a rien de mystérieux. */}
              {mode === "shots" && haveList && pick.mode === "spread" && props.plannedCount != null && !props.planError
                ? ` (${checked} shot${checked > 1 ? "s" : ""} × ${pick.count})` : ""}
              {props.output === "stills" && s.export.overlay ? " · with overlay" : ""}
              {props.output === "stills" && s.export.subfolder ? " · in a subfolder" : ""}
              {props.output === "sheet" ? ` · ${s.sheet.columns} columns · ${s.sheet.format.toUpperCase()}` : ""}
            </p>
            <button type="button" className="btn-capture" disabled={!props.plannedCount || (mode === "shots" && !haveList)}
              onClick={props.onExport}>{exportLabel}</button>
          </>
        )}
      </div>
    </div>
  );
}
