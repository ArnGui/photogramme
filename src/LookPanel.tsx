// Onglet « Look » : l'habillage des images exportées (overlay). Construit
// comme un panneau de calques : on choisit un calque (cadre, bande de palette,
// scope incrusté, textes) et ses propriétés s'affichent dessous, pendant que
// l'aperçu d'export reste visible dans la visionneuse.
//
// Chaque modification part immédiatement dans l'état local (aperçu
// instantané) ; l'enregistrement côté Rust est différé par App.

import { useEffect, useState } from "react";
import { TOKEN_HELP } from "./compose";
import { AnchorPicker, Choice, ColorField, FontDatalist, NumberField, TextField, Toggle } from "./fields";
import { IconEye, IconFolder } from "./icons";
import type { Font, OverlayPreset, Settings, TextItem } from "./types";

type Props = {
  settings: Settings;
  /** Calque sélectionné : tenu par App pour que la palette de commandes puisse y mener. */
  layer: LayerId;
  onLayer: (l: LayerId) => void;
  presets: OverlayPreset[];
  onChange: (s: Settings) => void;
  onSavePreset: (p: OverlayPreset) => void;
  onDeletePreset: (name: string) => void;
  onOpenPresets: () => void;
};

/** Calque sélectionné : cadre, bande de palette, scope, ou un texte (par position). */
export type LayerId = "frame" | "palette" | "scope" | `text:${number}`;

export const MAX_TEXTS = 12;

export function newText(): TextItem {
  return {
    id: `text-${Date.now()}`, enabled: true, template: "{film}",
    font: { family: "Barlow", size: 28, weight: 500, italic: false }, color: "#FFFFFF", opacity: 1,
    uppercase: false, letterSpacing: 0, anchor: "topLeft", region: "image", offsetX: 32, offsetY: 32,
    shadow: true, boxEnabled: false, boxColor: "#000000", boxOpacity: 0.5, boxPadding: 8,
  };
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

function TextEditor({ item, onChange, onRemove }: { item: TextItem; onChange: (t: TextItem) => void; onRemove: () => void }) {
  return (
    <>
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
    </>
  );
}

function PresetBar({ settings, presets, onChange, onSavePreset, onDeletePreset, onOpenPresets }: Props) {
  const [name, setName] = useState(settings.overlay.name);
  useEffect(() => setName(settings.overlay.name), [settings.overlay.name]);
  const current = presets.find((p) => p.name === settings.overlay.name);
  const modified = !current || JSON.stringify(current) !== JSON.stringify(settings.overlay);
  return (
    <div className="preset-bar">
      <div className="preset-row">
        <select id="preset-select" className="text" aria-label="Preset" value={current ? current.name : ""}
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) onChange({ ...settings, overlay: structuredClone(p) });
          }}>
          {!current && <option value="">{settings.overlay.name} (unsaved)</option>}
          {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button type="button" className="btn-icon-flat" aria-label="Open the presets folder" onClick={onOpenPresets}
          title="The presets are JSON files: copy them to back them up or share them.">
          <IconFolder size={15} />
        </button>
      </div>
      {modified && current && <p className="hint">Modified since the preset was loaded.</p>}
      <div className="preset-row">
        <input className="text" aria-label="Preset name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn-small" disabled={!name.trim()}
          onClick={() => {
            const p = { ...settings.overlay, name: name.trim() };
            onChange({ ...settings, overlay: p });
            onSavePreset(p);
          }}>Save as</button>
        <button type="button" className="btn-small" disabled={!current} onClick={() => current && onDeletePreset(current.name)}>Delete</button>
      </div>
    </div>
  );
}

export function LookPanel(props: Props) {
  const { settings: s, onChange, layer, onLayer: setLayer } = props;
  const o = s.overlay;
  const setOverlay = (overlay: OverlayPreset) => onChange({ ...s, overlay });
  const setText = (i: number, t: TextItem) => setOverlay({ ...o, texts: o.texts.map((x, j) => (j === i ? t : x)) });

  // Un texte supprimé (ou un préréglage avec moins de textes) ne laisse jamais de sélection orpheline.
  const textIndex = layer.startsWith("text:") ? Number(layer.slice(5)) : -1;
  useEffect(() => {
    if (textIndex >= o.texts.length) setLayer(o.texts.length ? `text:${o.texts.length - 1}` : "frame");
  }, [textIndex, o.texts.length, setLayer]);

  const layers: { id: LayerId; name: string; hint: string; visible: boolean | null; toggle?: (v: boolean) => void; glyph: string }[] = [
    { id: "frame", glyph: "▭", name: "Frame", hint: `${o.frame.padTop}/${o.frame.padLeft}/${o.frame.padBottom} · ${o.frame.background}`, visible: null },
    {
      id: "palette", glyph: "▦", name: "Palette band", hint: `${s.palette.count} colors · ${o.palette.placement === "below" ? "below" : "over"}`,
      visible: o.palette.enabled, toggle: (enabled) => setOverlay({ ...o, palette: { ...o.palette, enabled } }),
    },
    {
      id: "scope", glyph: "∿", name: "Scope", hint: o.scope.kind, visible: o.scope.enabled,
      toggle: (enabled) => setOverlay({ ...o, scope: { ...o.scope, enabled } }),
    },
    ...o.texts.map((t, i) => ({
      id: `text:${i}` as LayerId, glyph: "T", name: textName(t, i), hint: t.template.length > 18 ? `${t.template.slice(0, 17)}…` : t.template || "(empty)",
      visible: t.enabled, toggle: (enabled: boolean) => setText(i, { ...t, enabled }),
    })),
  ];

  return (
    <div className="look">
      <FontDatalist />
      <PresetBar {...props} />
      <Toggle label="Apply the look to exported stills" checked={s.export.overlay}
        onChange={(overlay) => onChange({ ...s, export: { ...s.export, overlay } })}
        hint="Off: stills are exported clean; the preview still shows the look." />

      <div className="layers">
        <div className="panel-head">
          <span className="section-label">Layers</span>
          <button type="button" className="btn-link small" disabled={o.texts.length >= MAX_TEXTS}
            onClick={() => {
              setOverlay({ ...o, texts: [...o.texts, newText()] });
              setLayer(`text:${o.texts.length}`);
            }}>+ Text</button>
        </div>
        <ul className="layer-list" role="listbox" aria-label="Layers">
          {layers.map((l) => (
            <li key={l.id} role="option" aria-selected={layer === l.id} className={`layer ${layer === l.id ? "is-selected" : ""}`}
              tabIndex={0} onClick={() => setLayer(l.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setLayer(l.id);
                }
              }}>
              {l.toggle ? (
                <button type="button" className={`layer-eye ${l.visible ? "" : "is-off"}`} aria-pressed={!!l.visible}
                  aria-label={`${l.visible ? "Hide" : "Show"} ${l.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    l.toggle?.(!l.visible);
                  }}><IconEye /></button>
              ) : <span className="layer-eye is-fixed" aria-hidden><IconEye /></span>}
              <span className="layer-glyph" aria-hidden>{l.glyph}</span>
              <span className={`layer-name ${l.visible === false ? "is-off" : ""}`}>{l.name}</span>
              <span className="layer-hint mono">{l.hint}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="layer-props" aria-label="Layer properties">
        <span className="section-label">{layers.find((l) => l.id === layer)?.name ?? "Frame"}</span>
        <p className="hint">Sizes are in pixels for a 1920 px wide frame and scale with the film (×2 in UHD).</p>
        {layer === "frame" && (
          <>
            <NumberField label="Top margin" unit="px" value={o.frame.padTop} min={0} max={600}
              onChange={(padTop) => setOverlay({ ...o, frame: { ...o.frame, padTop } })} />
            <NumberField label="Side margins" unit="px" value={o.frame.padLeft} min={0} max={600}
              onChange={(v) => setOverlay({ ...o, frame: { ...o.frame, padLeft: v, padRight: v } })} />
            <NumberField label="Bottom margin" unit="px" value={o.frame.padBottom} min={0} max={600}
              onChange={(padBottom) => setOverlay({ ...o, frame: { ...o.frame, padBottom } })} />
            <ColorField label="BACKGROUND" value={o.frame.background}
              onChange={(background) => setOverlay({ ...o, frame: { ...o.frame, background } })} />
          </>
        )}
        {layer === "palette" && (
          <>
            <Toggle label="Show the palette band" checked={o.palette.enabled}
              onChange={(enabled) => setOverlay({ ...o, palette: { ...o.palette, enabled } })} />
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
          </>
        )}
        {layer === "scope" && (
          <>
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
          </>
        )}
        {textIndex >= 0 && o.texts[textIndex] && (
          <TextEditor key={`${o.texts[textIndex].id}-${textIndex}`} item={o.texts[textIndex]} onChange={(t) => setText(textIndex, t)}
            onRemove={() => setOverlay({ ...o, texts: o.texts.filter((_, j) => j !== textIndex) })} />
        )}
      </div>
    </div>
  );
}

/** Nom lisible d'un texte d'overlay, tiré de son premier jeton. */
export function textName(t: TextItem, i: number): string {
  const m = /\{(\w+)\}/.exec(t.template);
  const names: Record<string, string> = {
    film: "Title", file: "File name", tc: "Timecode", frame: "Frame number", shot: "Shot", fps: "Frame rate",
    res: "Resolution", date: "Date", clip: "Clip name",
  };
  return (m && names[m[1]]) || `Text ${i + 1}`;
}
