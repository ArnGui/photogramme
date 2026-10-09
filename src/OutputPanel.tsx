// Onglet « Output » : où et comment les fichiers sont écrits. Images,
// planche contact et code-barre ; le bouton d'export reste dans Extract
// (on choisit ce qu'on exporte là où on choisit les images).

import { Choice, NumberField, Section, TextField, Toggle } from "./fields";
import { FILE_MANAGER } from "./platform";
import { IconFolder } from "./icons";
import type { Settings } from "./types";

function qualityHint(q: number) {
  if (q >= 95) return "Visually near-lossless";
  if (q >= 85) return "Recommended for archives";
  if (q >= 70) return "Web sharing";
  return "Draft";
}

export function colorHint(c: Settings["export"]["color"]) {
  if (c === "untagged") return "Pixels as graded, no profile: what most software shows (read as sRGB, a touch lighter than a 2.4 grading monitor).";
  if (c === "rec709") return "Pixels as graded + a Rec.709 / BT.1886 (gamma 2.4) profile: color-managed apps (Photoshop, Lightroom, Affinity) show the grade as on the grading monitor.";
  return "Converted from gamma 2.4 to sRGB with an sRGB profile: looks the same everywhere, best for the web and social media. The deepest shadows get slightly crushed.";
}

export function OutputPanel({ settings: s, onChange, onPickDir, onOpenDir, onExportBarcode, canExportBarcode }: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onPickDir: () => void;
  onOpenDir: () => void;
  onExportBarcode: () => void;
  canExportBarcode: boolean;
}) {
  return (
    <div className="output">
      <div className="field">
        <span className="section-label">Destination</span>
        <div className="dir-row">
          <button type="button" className="dir-picker" onClick={onPickDir} title={s.outputDir ? `Change the folder (${s.outputDir})` : undefined}>
            <IconFolder />
            <span className="dir-path">{s.outputDir ? `‎${s.outputDir}‎` : "Choose a folder…"}</span>
          </button>
          {s.outputDir && (
            <button type="button" className="btn-small dir-open" onClick={onOpenDir} title={`Open this folder in ${FILE_MANAGER}`}>Show</button>
          )}
        </div>
      </div>

      <div className="output-block">
        <span className="section-label">Stills</span>
        <Choice label="FORMAT" value={s.export.format} options={[["jpeg", "JPEG"], ["png", "PNG (lossless)"]]}
          onChange={(format) => onChange({ ...s, export: { ...s.export, format } })} />
        {s.export.format === "jpeg" ? (
          <>
            <NumberField label="JPEG quality" value={s.quality} min={50} max={100} onChange={(q) => onChange({ ...s, quality: Math.round(q) })}
              hint={qualityHint(s.quality)} />
            <Choice label="CHROMA SUBSAMPLING" value={s.chroma} options={[["4:4:4", "4:4:4"], ["4:2:0", "4:2:0"]]}
              onChange={(chroma) => onChange({ ...s, chroma })} />
            <p className="hint">{s.chroma === "4:4:4" ? "Sharp colors, best for palettes. ~30% heavier." : "Standard JPEG, lighter."}</p>
          </>
        ) : (
          <p className="hint">8-bit PNG, no compression loss. Files are 5 to 10 times heavier than JPEG q92.</p>
        )}
        <Choice label="COLOR" value={s.export.color}
          options={[["untagged", "As is"], ["rec709", "Tag Rec.709"], ["srgb", "Convert to sRGB"]]}
          onChange={(color) => onChange({ ...s, export: { ...s.export, color } })} />
        <p className="hint">{colorHint(s.export.color)}</p>
        <Choice label="TIMECODE" value={s.export.timecode} options={[["file", "From the file"], ["zero", "From 00:00:00:00"]]}
          onChange={(timecode) => onChange({ ...s, export: { ...s.export, timecode } })} />
        <p className="hint">Masters usually start at 01:00:00:00: keep the file's timecode to match your edit and EDLs.</p>
        <Toggle label="Batch exports in a subfolder" checked={s.export.subfolder}
          onChange={(subfolder) => onChange({ ...s, export: { ...s.export, subfolder } })} hint="e.g. MyFilm_shots" />
        <Toggle label="Write a CSV list" checked={s.export.csv}
          onChange={(csv) => onChange({ ...s, export: { ...s.export, csv } })} hint="Opens in Excel (semicolon-separated): file, timecodes, shot, clip name." />
        {s.export.csv && (
          <Toggle label="Add each frame's palette to the CSV" checked={s.export.csvPalette}
            onChange={(csvPalette) => onChange({ ...s, export: { ...s.export, csvPalette } })} hint="Hex codes, same settings as the palette." />
        )}
        <p className="hint">The look (overlay) burnt into the stills is set in the LOOK tab.</p>
      </div>

      <Section title="CONTACT SHEET" summary={`${s.sheet.format.toUpperCase()} · ${s.sheet.page === "image" ? "image" : s.sheet.page.toUpperCase()} · ${s.sheet.columns} col · ${s.sheet.theme}`}>
        <p className="hint">Extract › Contact sheet lays out the planned frames (shots, interval or N frames, within the in/out points) on printable pages.</p>
        <Choice label="FORMAT" value={s.sheet.format} options={[["pdf", "PDF"], ["jpeg", "JPEG"], ["png", "PNG"]]}
          onChange={(format) => onChange({ ...s, sheet: { ...s.sheet, format } })} />
        <Choice label="PAGE" value={s.sheet.page}
          options={[["a4", "A4"], ["a3", "A3"], ["letter", "Letter"], ["tabloid", "Tabloid"], ["image", "One image"]]}
          onChange={(page) => onChange({ ...s, sheet: { ...s.sheet, page } })} />
        {s.sheet.page === "image" ? (
          <NumberField label="Image width" unit="px" value={s.sheet.imageWidth} min={640} max={16000} step={160}
            onChange={(imageWidth) => onChange({ ...s, sheet: { ...s.sheet, imageWidth: Math.round(imageWidth) } })} />
        ) : (
          <>
            <Toggle label="Landscape" checked={s.sheet.landscape} onChange={(landscape) => onChange({ ...s, sheet: { ...s.sheet, landscape } })} />
            <Choice label="RESOLUTION" value={String(s.sheet.dpi)} options={[["150", "150 dpi"], ["200", "200 dpi"], ["300", "300 dpi"]]}
              onChange={(d) => onChange({ ...s, sheet: { ...s.sheet, dpi: Number(d) } })} />
          </>
        )}
        <NumberField label="Columns" value={s.sheet.columns} min={1} max={12}
          onChange={(columns) => onChange({ ...s, sheet: { ...s.sheet, columns: Math.round(columns) } })} />
        <Choice label="THEME" value={s.sheet.theme} options={[["dark", "Dark"], ["light", "Light (print)"]]}
          onChange={(theme) => onChange({ ...s, sheet: { ...s.sheet, theme } })} />
        <TextField label="TITLE" value={s.sheet.title} onChange={(title) => onChange({ ...s, sheet: { ...s.sheet, title } })} />
        <p className="hint">Tokens: {"{film} {date} {count}"}</p>
        <span className="label">CAPTIONS</span>
        <Toggle label="Timecode" checked={s.sheet.showTc} onChange={(showTc) => onChange({ ...s, sheet: { ...s.sheet, showTc } })} />
        <Toggle label="Shot number" checked={s.sheet.showShot} onChange={(showShot) => onChange({ ...s, sheet: { ...s.sheet, showShot } })} />
        <Toggle label="Clip name (edit list)" checked={s.sheet.showClip} onChange={(showClip) => onChange({ ...s, sheet: { ...s.sheet, showClip } })} />
        <Toggle label="Frame number" checked={s.sheet.showFrame} onChange={(showFrame) => onChange({ ...s, sheet: { ...s.sheet, showFrame } })} />
        <Toggle label="Palette strip" checked={s.sheet.showPalette} onChange={(showPalette) => onChange({ ...s, sheet: { ...s.sheet, showPalette } })} />
      </Section>

      <Section title="BARCODE" summary={`${s.barcode.width}×${s.barcode.height} · ${s.barcode.mode === "vertical" ? "vertical" : "one color"}`}>
        <Choice label="STYLE" value={s.barcode.mode} options={[["vertical", "Keeps vertical structure"], ["average", "One color per slice"]]}
          onChange={(mode) => onChange({ ...s, barcode: { ...s.barcode, mode } })} />
        <NumberField label="Export width" unit="px" value={s.barcode.width} min={16} max={16384} step={16}
          onChange={(width) => onChange({ ...s, barcode: { ...s.barcode, width: Math.round(width) } })} />
        <NumberField label="Export height" unit="px" value={s.barcode.height} min={4} max={16384} step={4}
          onChange={(height) => onChange({ ...s, barcode: { ...s.barcode, height: Math.round(height) } })} />
        <button type="button" className="btn-secondary" disabled={!canExportBarcode} onClick={onExportBarcode}
          title={canExportBarcode ? "Saves the barcode as a JPEG in the output folder" : "Analyze the film first (Extract)"}>Export barcode</button>
      </Section>
    </div>
  );
}
