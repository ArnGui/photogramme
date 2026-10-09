// Palette de commandes (Ctrl K / ⌘K) et aide des raccourcis (?).

import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands } from "./commands";
import type { Command } from "./commands";
import { IconSearch } from "./icons";
import { IS_MAC, shortcut } from "./platform";

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: Command[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setActive(0);
      d.showModal();
      input.current?.focus();
      // Si un reste de recherche s'affiche encore, la première touche le remplace.
      input.current?.select();
    }
    if (!open && d.open) d.close();
    // Recherche vidée dès la fermeture : vidée seulement à l'ouverture, une frappe rapide
    // passait avant le rendu et s'ajoutait à l'ancienne (« zoom 200zoom 100 »).
    if (!open) {
      setQuery("");
      setActive(0);
    }
    // Fermée : son champ garderait le clavier jusqu'au rendu suivant (Chromium), et une
    // touche tapée entre-temps (Ctrl+K juste après une commande) serait prise pour une saisie.
    if (!open && d.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    (listRef.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    // Après fermeture : la commande peut ouvrir une autre fenêtre ou un sélecteur.
    setTimeout(c.run, 0);
  };
  let lastGroup = "";

  return (
    <dialog ref={ref} className="palette" aria-label="Commands" onCancel={(e) => {
        // Échap : l'état de l'application décide de la fermeture (jamais le navigateur seul).
        e.preventDefault();
        onClose();
      }}
      // Fermée quand même par le navigateur (Échap répété, par exemple) : l'état suit.
      // L'événement « close » arrive en différé : s'il concerne une fermeture d'avant une
      // réouverture rapide (Ctrl+K juste après une commande), la fenêtre est de nouveau
      // ouverte et l'événement est ignoré.
      onClose={(e) => !e.currentTarget.open && onClose()}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette-box">
        <div className="palette-search">
          <IconSearch size={16} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search commands and settings"
            aria-label="Search commands and settings" role="combobox" aria-expanded aria-controls="palette-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(results[active]);
              }
            }} />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="palette-empty">No command matches “{query}”.</li>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === active} aria-disabled={c.disabled || undefined}
                className={`palette-item ${i === active ? "is-active" : ""} ${c.disabled ? "is-disabled" : ""}`}
                data-group={head ?? undefined}
                // Le champ de recherche garde le clavier, même après un clic (sur une commande grisée aussi).
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)} onClick={() => run(c)}>
                <span className="palette-group">{c.group}</span>
                <span className="palette-label">{c.label}</span>
                {c.value && <span className="palette-value">{c.value}</span>}
                {c.shortcut && <kbd>{c.shortcut}</kbd>}
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> run</span>
          <span className="push">Every command, setting and shortcut is here.</span>
        </div>
      </div>
    </dialog>
  );
}

const mod = IS_MAC ? "⌥" : "Alt";
export const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["J / K / L", "Shuttle backward / stop / forward (press again to go faster)"],
  ["← / →", "Previous / next frame"],
  ["Shift + ← / →", "Back / forward one second"],
  ["Home / End", "First / last frame"],
  ["I / O", "Mark in / mark out"],
  [`${mod} + X`, "Clear in and out"],
  ["C", "Capture the displayed frame"],
  ["B", "Add a cut at the playhead"],
  ["P", "Export preview on / off"],
  ["Z", "Zoom: fit, 100 %, 200 %"],
  ["R", "Set the displayed frame as reference A"],
  ["W", "A/B wipe on / off"],
  ["S", "Scopes"],
  [shortcut("O"), "Open a film"],
  [shortcut("K"), "Commands and settings"],
  [shortcut(","), "Preferences"],
  ["?", "This list"],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    // Fermée : son champ garderait le clavier jusqu'au rendu suivant (Chromium), et une
    // touche tapée entre-temps (Ctrl+K juste après une commande) serait prise pour une saisie.
    if (!open && d.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [open]);
  return (
    <dialog ref={ref} className="shortcuts-dialog" aria-labelledby="shortcuts-title" onCancel={(e) => {
        // Échap : l'état de l'application décide de la fermeture (jamais le navigateur seul).
        e.preventDefault();
        onClose();
      }}
      // Fermée quand même par le navigateur (Échap répété, par exemple) : l'état suit.
      // L'événement « close » arrive en différé : s'il concerne une fermeture d'avant une
      // réouverture rapide (Ctrl+K juste après une commande), la fenêtre est de nouveau
      // ouverte et l'événement est ignoré.
      onClose={(e) => !e.currentTarget.open && onClose()}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcuts-box">
        <div className="prefs-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="btn-mini" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="shortcut-row"><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>
          ))}
        </dl>
        <p className="hint">Shortcuts are ignored while you type in a field.</p>
      </div>
    </dialog>
  );
}
