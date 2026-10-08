// Panneau de réglages : Export / Shots / Palette / Overlay / Contact sheet /
// About. Chaque modification part immédiatement dans l'état local (aperçu
// instantané) ; l'enregistrement côté Rust est différé par App.

import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { formatBytes } from "./timecode";
import { TOKEN_HELP } from "./compose";
import {
  AnchorPicker, Choice, ColorField, FontDatalist, Group, NumberField, Section, TextField, Toggle,
} from "./fields";
import { IconFolder } from "./icons";
import type { AppInfo, Font, Link, OverlayPreset, Pick, Settings, TextItem, UpdateInfo } from "./types";

export interface UpdateState {
  checking: boolean;
  result: UpdateInfo | null;
  error: string | null;
}

type Props = {
  settings: Settings;
  presets: OverlayPreset[];
  appInfo: AppInfo | null;
  update: UpdateState;
  onChange: (s: Settings) => void;
  onPickDir: () => void;
  onOpenDir: () => void;
  onSavePreset: (p: OverlayPreset) => void;
  onDeletePreset: (name: string) => void;
  onOpenPresets: () => void;
  onCheckUpdate: () => void;
  onOpenLink: (l: Link) => void;
};

function qualityHint(q: number) {
  if (q >= 95) return "Visually near-lossless";
  if (q >= 85) return "Recommended for archives";
  if (q >= 70) return "Web sharing";
  return "Draft";
}

export function PickField({ pick, onChange }: { pick: Pick; onChange: (p: Pick) => void }) {
  const count = pick.mode === "spread" ? pick.count : 3;
  return (
    <>
      <Choice
        label="FRAME KEPT PER SHOT"
        value={pick.mode}
        options={[["first", "First"], ["middle", "Middle"], ["last", "Last"], ["spread", "N spread"]]}
        onChange={(m) => onChange(m === "spread" ? { mode: "spread", count } : { mode: m })}
      />
      {pick.mode === "spread" && (
        <NumberField label="Frames per shot" value={count} min={1} max={20}
          onChange={(c) => onChange({ mode: "spread", count: Math.round(c) })} />
      )}
    </>
  );
}

function FontFields({ font, onChange }: { font: Font; onChange: (f: Font) => void }) {
  return (
    <>
      <TextField label="FONT" value={font.family} list="font-list" onChange={(family) => onChange({ ...font, family })} />
      <NumberField label="Size" unit="px" value={font.size} min={4} max={200} onChange={(size) => onChange({ ...font, size })} />
      <Choice
        label="WEIGHT"
        value={String(font.weight)}
        options={[["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semi"], ["700", "Bold"]]}
        onChange={(w) => onChange({ ...font, weight: Number(w) })}
      />
      <Toggle label="Italic" checked={font.italic} onChange={(italic) => onChange({ ...font, italic })} />
    </>
  );
}

function TextItemEditor({ item, onChange, onRemove }: { item: TextItem; onChange: (t: TextItem) => void; onRemove: () => void }) {
  return (
    <details className="text-item">
      <summary>
        <input type="checkbox" checked={item.enabled} aria-label={`Show ${item.id}`}
          onClick={(e) => e.stopPropagation()} onChange={(e) => onChange({ ...item, enabled: e.target.checked })} />
        <span className="mono">{item.template || "(empty)"}</span>
      </summary>
      <div className="section-body">
        <TextField label="TEXT" value={item.template} multiline onChange={(template) => onChange({ ...item, template })} />
        <p className="hint">Tokens: {TOKEN_HELP}</p>
        <FontFields font={item.font} onChange={(font) => onChange({ ...item, font })} />
        <ColorField label="COLOR" value={item.color} onChange={(color) => onChange({ ...item, color })} />
        <NumberField label="Opacity" value={item.opacity} min={0} max={1} step={0.05} onChange={(opacity) => onChange({ ...item, opacity })} />
        <NumberField label="Letter spacing" unit="px" value={item.letterSpacing} min={-5} max={40} step={0.5}
          onChange={(letterSpacing) => onChange({ ...item, letterSpacing })} />
        <Toggle label="Uppercase" checked={item.uppercase} onChange={(uppercase) => onChange({ ...item, uppercase })} />
        <AnchorPicker value={item.anchor} onChange={(anchor) => onChange({ ...item, anchor })} />
        <Choice label="RELATIVE TO" value={item.region}
          options={[["image", "Film frame"], ["canvas", "Whole canvas"]]}
          onChange={(region) => onChange({ ...item, region })} />
        <NumberField label="Margin X" unit="px" value={item.offsetX} min={-400} max={1000} onChange={(offsetX) => onChange({ ...item, offsetX })} />
        <NumberField label="Margin Y" unit="px" value={item.offsetY} min={-400} max={1000} onChange={(offsetY) => onChange({ ...item, offsetY })} />
        <Toggle label="Drop shadow" checked={item.shadow} onChange={(shadow) => onChange({ ...item, shadow })} />
        <Toggle label="Background box" checked={item.boxEnabled} onChange={(boxEnabled) => onChange({ ...item, boxEnabled })} />
        {item.boxEnabled && (
          <>
            <ColorField label="BOX COLOR" value={item.boxColor} onChange={(boxColor) => onChange({ ...item, boxColor })} />
            <NumberField label="Box opacity" value={item.boxOpacity} min={0} max={1} step={0.05} onChange={(boxOpacity) => onChange({ ...item, boxOpacity })} />
            <NumberField label="Box padding" unit="px" value={item.boxPadding} min={0} max={100} onChange={(boxPadding) => onChange({ ...item, boxPadding })} />
          </>
        )}
        <button type="button" className="btn-danger" onClick={onRemove}>Remove this text</button>
      </div>
    </details>
  );
}

function PresetBar({ settings, presets, onChange, onSavePreset, onDeletePreset, onOpenPresets }: Props) {
  const [name, setName] = useState(settings.overlay.name);
  const current = presets.find((p) => p.name === settings.overlay.name);
  const modified = !current || JSON.stringify(current) !== JSON.stringify(settings.overlay);
  return (
    <div className="preset-bar">
      <div className="field">
        <label className="label" htmlFor="preset-select">PRESET</label>
        <select id="preset-select" className="text" value={current ? current.name : ""}
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) {
              onChange({ ...settings, overlay: structuredClone(p) });
              setName(p.name);
            }
          }}>
          {!current && <option value="">{settings.overlay.name} (unsaved)</option>}
          {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        {modified && current && <p className="hint">Modified since the preset was loaded.</p>}
      </div>
      <div className="row">
        <input className="text" aria-label="Preset name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn-small" disabled={!name.trim()}
          onClick={() => {
            const p = { ...settings.overlay, name: name.trim() };
            onChange({ ...settings, overlay: p });
            onSavePreset(p);
          }}>Save</button>
      </div>
      <div className="row">
        <button type="button" className="btn-small" disabled={!current} onClick={() => current && onDeletePreset(current.name)}>Delete</button>
        <button type="button" className="btn-small" onClick={onOpenPresets} title="The presets are JSON files: copy them to back them up or share them.">
          <IconFolder size={14} /> Presets folder
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel(props: Props) {
  const { settings: s, onChange, onPickDir, onOpenDir } = props;
  const o = s.overlay;
  const setOverlay = (overlay: OverlayPreset) => onChange({ ...s, overlay });
  const setText = (i: number, t: TextItem) => setOverlay({ ...o, texts: o.texts.map((x, j) => (j === i ? t : x)) });

  return (
    <div className="settings">
      <FontDatalist />

      <Section title="EXPORT" defaultOpen>
        <div className="field">
          <span className="label">OUTPUT FOLDER</span>
          <div className="dir-row">
            <button type="button" className="dir-picker" onClick={onPickDir} title={s.outputDir ? `Change the folder (${s.outputDir})` : undefined}>
              <IconFolder />
              <span className="dir-path">{s.outputDir ? `\u200E${s.outputDir}\u200E` : "Choose a folder…"}</span>
            </button>
            {s.outputDir && (
              <button type="button" className="btn-small dir-open" onClick={onOpenDir} title="Open this folder in Explorer">Open</button>
            )}
          </div>
        </div>
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
        <Toggle label="Apply the overlay to exports" checked={s.export.overlay}
          onChange={(overlay) => onChange({ ...s, export: { ...s.export, overlay } })}
          hint="Palette, timecode and texts burnt into the JPEG." />
        <Toggle label="Batch exports in a subfolder" checked={s.export.subfolder}
          onChange={(subfolder) => onChange({ ...s, export: { ...s.export, subfolder } })} hint="e.g. MyFilm_shots" />
        <Toggle label="Write a CSV list" checked={s.export.csv}
          onChange={(csv) => onChange({ ...s, export: { ...s.export, csv } })} hint="Opens in Excel (semicolon-separated): file, timecodes, shot, clip name." />
        {s.export.csv && (
          <Toggle label="Add each frame's palette to the CSV" checked={s.export.csvPalette}
            onChange={(csvPalette) => onChange({ ...s, export: { ...s.export, csvPalette } })} hint="Hex codes, same settings as the palette." />
        )}
      </Section>

      <Section title="SHOTS">
        <NumberField label="Detection threshold" value={s.shots.threshold} min={3} max={60} step={0.5}
          onChange={(threshold) => onChange({ ...s, shots: { ...s.shots, threshold } })}
          hint="Lower = more cuts. 10 is FFmpeg's default." />
        <NumberField label="Minimum shot length" unit="s" value={s.shots.minSeconds} min={0} max={10} step={0.1}
          onChange={(minSeconds) => onChange({ ...s, shots: { ...s.shots, minSeconds } })}
          hint="Ignores flashes and very fast cuts." />
        <PickField pick={s.shots.pick} onChange={(pick) => onChange({ ...s, shots: { ...s.shots, pick } })} />
        <Choice label="ANALYSIS DECODER" value={s.shots.decoder}
          options={[["auto", "Auto"], ["gpu", "GPU (NVDEC)"], ["cpu", "CPU"]]}
          onChange={(decoder) => onChange({ ...s, shots: { ...s.shots, decoder } })} />
        <p className="hint">Auto uses the RTX 3080 when the file allows it and falls back to the CPU on failure.</p>
      </Section>

      <Section title="PALETTE">
        <NumberField label="Number of colors" value={s.palette.count} min={1} max={16}
          onChange={(count) => onChange({ ...s, palette: { ...s.palette, count: Math.round(count) } })} />
        <Choice label="ORDER" value={s.palette.sort}
          options={[["share", "Most present"], ["hue", "Hue"], ["lightness", "Dark → light"]]}
          onChange={(sort) => onChange({ ...s, palette: { ...s.palette, sort } })} />
        <Choice label="WEIGHTING" value={s.palette.weighting}
          options={[["area", "By area"], ["accents", "Favor accents"]]}
          onChange={(weighting) => onChange({ ...s, palette: { ...s.palette, weighting } })} />
        <p className="hint">{s.palette.weighting === "area"
          ? "Large surfaces dominate, like a light meter."
          : "Saturated pixels count more: a small red coat in a grey shot gets its own swatch. Shares stay area shares."}</p>
        <Toggle label="Ignore black bars" checked={s.palette.ignoreBars}
          onChange={(ignoreBars) => onChange({ ...s, palette: { ...s.palette, ignoreBars } })}
          hint="Letterbox bars would otherwise count as a dominant black." />
        <Group title="FILM BARCODE">
          <Choice label="STYLE" value={s.barcode.mode} options={[["vertical", "Keeps vertical structure"], ["average", "One color per slice"]]}
            onChange={(mode) => onChange({ ...s, barcode: { ...s.barcode, mode } })} />
          <NumberField label="Export width" unit="px" value={s.barcode.width} min={16} max={16384} step={16}
            onChange={(width) => onChange({ ...s, barcode: { ...s.barcode, width: Math.round(width) } })} />
          <NumberField label="Export height" unit="px" value={s.barcode.height} min={4} max={16384} step={4}
            onChange={(height) => onChange({ ...s, barcode: { ...s.barcode, height: Math.round(height) } })} />
        </Group>
      </Section>

      <Section title="OVERLAY">
        <PresetBar {...props} />
        <p className="hint">Sizes are in pixels for a 1920 px wide frame and scale with the film (×2 in UHD). Press <kbd>P</kbd> to see the exact export preview while you edit.</p>
        <Group title="FRAME">
          <NumberField label="Top margin" unit="px" value={o.frame.padTop} min={0} max={600}
            onChange={(padTop) => setOverlay({ ...o, frame: { ...o.frame, padTop } })} />
          <NumberField label="Side margins" unit="px" value={o.frame.padLeft} min={0} max={600}
            onChange={(v) => setOverlay({ ...o, frame: { ...o.frame, padLeft: v, padRight: v } })} />
          <NumberField label="Bottom margin" unit="px" value={o.frame.padBottom} min={0} max={600}
            onChange={(padBottom) => setOverlay({ ...o, frame: { ...o.frame, padBottom } })} />
          <ColorField label="BACKGROUND" value={o.frame.background}
            onChange={(background) => setOverlay({ ...o, frame: { ...o.frame, background } })} />
        </Group>
        <Group title="PALETTE BAND">
          <Toggle label="Show the palette" checked={o.palette.enabled}
            onChange={(enabled) => setOverlay({ ...o, palette: { ...o.palette, enabled } })} />
          {o.palette.enabled && (
            <>
              <Choice label="PLACEMENT" value={o.palette.placement} options={[["below", "Below the frame"], ["inside", "Over the frame"]]}
                onChange={(placement) => setOverlay({ ...o, palette: { ...o.palette, placement } })} />
              <Choice label="SWATCHES" value={o.palette.style} options={[["squares", "Squares"], ["fill", "Full width"]]}
                onChange={(style) => setOverlay({ ...o, palette: { ...o.palette, style } })} />
              <NumberField label={o.palette.style === "fill" ? "Height" : "Square size"} unit="px" value={o.palette.size} min={4} max={600}
                onChange={(size) => setOverlay({ ...o, palette: { ...o.palette, size } })} />
              <NumberField label="Gap" unit="px" value={o.palette.gap} min={0} max={200}
                onChange={(gap) => setOverlay({ ...o, palette: { ...o.palette, gap } })} />
              <NumberField label="Distance from frame" unit="px" value={o.palette.margin} min={0} max={400}
                onChange={(margin) => setOverlay({ ...o, palette: { ...o.palette, margin } })} />
              {o.palette.style === "squares" && (
                <Choice label="ALIGN" value={o.palette.align} options={[["left", "Left"], ["center", "Center"], ["right", "Right"]]}
                  onChange={(align) => setOverlay({ ...o, palette: { ...o.palette, align } })} />
              )}
              <Toggle label="Show hex codes" checked={o.palette.showHex}
                onChange={(showHex) => setOverlay({ ...o, palette: { ...o.palette, showHex } })} />
              {o.palette.showHex && (
                <>
                  <FontFields font={o.palette.hexFont} onChange={(hexFont) => setOverlay({ ...o, palette: { ...o.palette, hexFont } })} />
                  <ColorField label="CODE COLOR" value={o.palette.hexColor}
                    onChange={(hexColor) => setOverlay({ ...o, palette: { ...o.palette, hexColor } })} />
                </>
              )}
            </>
          )}
        </Group>
        <Group title="SCOPE">
          <Toggle label="Burn a scope into the image" checked={o.scope.enabled}
            onChange={(enabled) => setOverlay({ ...o, scope: { ...o.scope, enabled } })}
            hint="Computed on the exact exported pixels, like the scopes panel (S)." />
          {o.scope.enabled && (
            <>
              <Choice label="KIND" value={o.scope.kind}
                options={[["waveform", "Waveform"], ["parade", "Parade"], ["vectorscope", "Vector"], ["histogram", "Histo"]]}
                onChange={(kind) => setOverlay({ ...o, scope: { ...o.scope, kind } })} />
              <NumberField label="Width" unit="px" value={o.scope.size} min={80} max={1920} step={10}
                onChange={(size) => setOverlay({ ...o, scope: { ...o.scope, size } })} />
              <NumberField label="Background opacity" value={o.scope.opacity} min={0} max={1} step={0.05}
                onChange={(opacity) => setOverlay({ ...o, scope: { ...o.scope, opacity } })} />
              <AnchorPicker value={o.scope.anchor} onChange={(anchor) => setOverlay({ ...o, scope: { ...o.scope, anchor } })} />
              <Choice label="RELATIVE TO" value={o.scope.region} options={[["image", "Film frame"], ["canvas", "Whole canvas"]]}
                onChange={(region) => setOverlay({ ...o, scope: { ...o.scope, region } })} />
              <NumberField label="Margin X" unit="px" value={o.scope.offsetX} min={-400} max={1000}
                onChange={(offsetX) => setOverlay({ ...o, scope: { ...o.scope, offsetX } })} />
              <NumberField label="Margin Y" unit="px" value={o.scope.offsetY} min={-400} max={1000}
                onChange={(offsetY) => setOverlay({ ...o, scope: { ...o.scope, offsetY } })} />
            </>
          )}
        </Group>
        <Group title="TEXTS">
          {o.texts.map((t, i) => (
            <TextItemEditor key={`${t.id}-${i}`} item={t} onChange={(nt) => setText(i, nt)}
              onRemove={() => setOverlay({ ...o, texts: o.texts.filter((_, j) => j !== i) })} />
          ))}
          <button type="button" className="btn-small" disabled={o.texts.length >= 12}
            onClick={() => setOverlay({
              ...o,
              texts: [...o.texts, {
                id: `text-${Date.now()}`, enabled: true, template: "{film}",
                font: { family: "Barlow", size: 28, weight: 500, italic: false }, color: "#FFFFFF", opacity: 1,
                uppercase: false, letterSpacing: 0, anchor: "topLeft", region: "image", offsetX: 32, offsetY: 32,
                shadow: true, boxEnabled: false, boxColor: "#000000", boxOpacity: 0.5, boxPadding: 8,
              }],
            })}>+ Add a text</button>
        </Group>
      </Section>

      <Section title="CONTACT SHEET">
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
        <Group title="CAPTIONS">
          <Toggle label="Timecode" checked={s.sheet.showTc} onChange={(showTc) => onChange({ ...s, sheet: { ...s.sheet, showTc } })} />
          <Toggle label="Shot number" checked={s.sheet.showShot} onChange={(showShot) => onChange({ ...s, sheet: { ...s.sheet, showShot } })} />
          <Toggle label="Clip name (edit list)" checked={s.sheet.showClip} onChange={(showClip) => onChange({ ...s, sheet: { ...s.sheet, showClip } })} />
          <Toggle label="Frame number" checked={s.sheet.showFrame} onChange={(showFrame) => onChange({ ...s, sheet: { ...s.sheet, showFrame } })} />
          <Toggle label="Palette strip" checked={s.sheet.showPalette} onChange={(showPalette) => onChange({ ...s, sheet: { ...s.sheet, showPalette } })} />
        </Group>
      </Section>

      <AboutSection {...props} />
    </div>
  );
}

function colorHint(c: Settings["export"]["color"]) {
  if (c === "untagged") return "Pixels as graded, no profile: what most software shows (read as sRGB, a touch lighter than a 2.4 grading monitor).";
  if (c === "rec709") return "Pixels as graded + a Rec.709 / BT.1886 (gamma 2.4) profile: color-managed apps (Photoshop, Lightroom, Affinity) show the grade as on the grading monitor.";
  return "Converted from gamma 2.4 to sRGB with an sRGB profile: looks the same everywhere, best for the web and social media. The deepest shadows get slightly crushed.";
}

function AboutSection({ settings: s, appInfo, update, onChange, onCheckUpdate, onOpenLink }: Props) {
  const r = update.result;
  return (
    <Section title="ABOUT">
      <p className="small">
        <strong>Photogramme {appInfo?.version ?? ""}</strong> · free software (GNU GPL v3) by Arnaud Guillard.
      </p>
      <ProjectsGroup />
      <Group title="UPDATES">
        {appInfo && !appInfo.updatesEnabled ? (
          <p className="hint">Automatic updates are not set up in this build (local build without an update key). Get new versions from the releases page.</p>
        ) : (
          <>
            <Toggle label="Check for updates at startup" checked={s.updates.checkAtStartup}
              onChange={(checkAtStartup) => onChange({ ...s, updates: { ...s.updates, checkAtStartup } })}
              hint="One request to GitHub when the app starts. Nothing else is sent." />
            <div className="row">
              <button type="button" className="btn-small" disabled={update.checking} onClick={onCheckUpdate}>
                {update.checking ? "Checking…" : "Check now"}
              </button>
              {r && !r.version && <span className="small muted">Photogramme is up to date.</span>}
              {r?.version && <span className="small">Version {r.version} is available (banner at the top).</span>}
            </div>
            {update.error && <p className="hint">{update.error}</p>}
          </>
        )}
      </Group>
      {appInfo?.kofi && (
        <Group title="SUPPORT">
          <p className="small">Photogramme is free. If it saves you time, you can buy me a coffee.</p>
          <button type="button" className="btn-kofi" onClick={() => onOpenLink("kofi")}>☕ Buy me a coffee on Ko-fi</button>
        </Group>
      )}
      <div className="row wrap">
        <button type="button" className="btn-small" onClick={() => onOpenLink("repo")}>Source code</button>
        <button type="button" className="btn-small" onClick={() => onOpenLink("releases")}>Releases</button>
        <button type="button" className="btn-small" onClick={() => onOpenLink("issues")}>Report a problem</button>
      </div>
    </Section>
  );
}

/** Projets : où est gardé le travail, et place prise par les analyses. */
function ProjectsGroup() {
  const [size, setSize] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api.projectCacheSize().then(setSize).catch(() => {});
  }, []);
  return (
    <Group title="PROJECTS">
      <p className="hint">
        Your work on each film (checked shots, cuts, in/out, captures, position) is saved as you go and comes back when you reopen it.
        Analyses are kept too, so a film does not need analyzing twice. They are capped at 2 GB, oldest first.
      </p>
      <div className="row">
        <button type="button" className="btn-small" disabled={!size} onClick={() => {
          api.projectCacheClear()
            .then((freed) => {
              setSize(0);
              setNote(`${formatBytes(freed)} freed. Your selections are kept.`);
            })
            .catch((e) => setNote(errorMessage(e)));
        }}>Clear saved analyses</button>
        <span className="small muted">{note ?? (size === null ? "" : size ? `${formatBytes(size)} used` : "Nothing saved yet")}</span>
      </div>
    </Group>
  );
}
