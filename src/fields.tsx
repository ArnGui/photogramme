// Contrôles de formulaire du panneau de réglages. Volontairement simples :
// pas de bibliothèque, tout au clavier, cibles de 32 px minimum.

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { Anchor } from "./types";

export function Section({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

/** Curseur + saisie numérique ; la saisie accepte des valeurs hors du curseur. */
export function NumberField({ label, value, min, max, step = 1, unit, onChange, hint }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void; hint?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (s: string) => {
    const v = Number(s.replace(",", "."));
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    else setText(String(value));
  };
  return (
    <div className="nfield">
      <label htmlFor={id}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} />
      <span className="nfield-input">
        <input id={id} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }} />
        {unit && <span className="unit">{unit}</span>}
      </span>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span className="toggle-label">{label}{hint && <span className="hint">{hint}</span>}</span>
    </label>
  );
}

export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="pills" role="group" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v} type="button" className="pill" aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const expand = (c: string) => (c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c.slice(0, 7));

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="cfield">
      <span className="label">{label}</span>
      <input type="color" aria-label={label} value={expand(HEX.test(value) ? value : "#000000")}
        onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <input className="mono" value={text} aria-label={`${label} (hex)`} maxLength={7}
        onChange={(e) => { setText(e.target.value); if (HEX.test(e.target.value)) onChange(e.target.value.toUpperCase()); }}
        onBlur={() => setText(value)} />
    </div>
  );
}

export function TextField({ label, value, onChange, list, placeholder, multiline }: {
  label: string; value: string; onChange: (v: string) => void; list?: string; placeholder?: string; multiline?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} className="text" rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="text" value={value} list={list} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

const ANCHORS: Anchor[] = ["topLeft", "top", "topRight", "left", "center", "right", "bottomLeft", "bottom", "bottomRight"];
const ANCHOR_NAMES: Record<Anchor, string> = {
  topLeft: "Top left", top: "Top", topRight: "Top right", left: "Left", center: "Center",
  right: "Right", bottomLeft: "Bottom left", bottom: "Bottom", bottomRight: "Bottom right",
};

export function AnchorPicker({ value, onChange }: { value: Anchor; onChange: (a: Anchor) => void }) {
  return (
    <div className="field">
      <span className="label">POSITION</span>
      <div className="anchor-grid" role="group" aria-label="Position">
        {ANCHORS.map((a) => (
          <button key={a} type="button" className="anchor-cell" aria-pressed={value === a} aria-label={ANCHOR_NAMES[a]}
            title={ANCHOR_NAMES[a]} onClick={() => onChange(a)}><span /></button>
        ))}
      </div>
    </div>
  );
}

/** Polices proposées : celles embarquées + les plus courantes de Windows. */
export const FONT_SUGGESTIONS = [
  "Barlow", "Barlow Condensed", "IBM Plex Mono",
  "Arial", "Arial Narrow", "Bahnschrift", "Calibri", "Cambria", "Candara", "Consolas", "Constantia",
  "Corbel", "Courier New", "Franklin Gothic Medium", "Georgia", "Impact", "Segoe UI", "Segoe UI Light",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
];

export function FontDatalist() {
  return (
    <datalist id="font-list">
      {FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}
    </datalist>
  );
}
