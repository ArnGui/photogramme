// Préférences de l'application (pas du film ni des exports) : apparence,
// analyse, mises à jour, projets, soutien, à propos et licences.

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { Choice, Toggle } from "./fields";
import { GPU_NAME, IS_MAC } from "./platform";
import { ACCENTS, SKINS } from "./theme";
import { formatBytes } from "./timecode";
import type { AppInfo, Link, Settings, Skin, UpdateInfo } from "./types";

export interface UpdateState {
  checking: boolean;
  result: UpdateInfo | null;
  error: string | null;
}

export type PrefsSection = "appearance" | "analysis" | "updates" | "projects" | "about";

const SECTIONS: [PrefsSection, string][] = [
  ["appearance", "Appearance"], ["analysis", "Analysis"], ["updates", "Updates"], ["projects", "Projects"], ["about", "About & licenses"],
];

/** Vignette d'un skin : couleurs de ses jetons, dessinées sans dépendre du skin actif. */
function SkinSwatch({ skin }: { skin: Skin }) {
  return (
    <span className={`skin-swatch skin-swatch-${skin}`} aria-hidden>
      <span className="sw-top"><span className="sw-logo" /><span className="sw-line" /></span>
      <span className="sw-decor" />
      <span className="sw-body">
        <span className="sw-main"><span className="sw-image" /><span className="sw-track"><span className="sw-head" /></span></span>
        <span className="sw-side"><span className="sw-row" /><span className="sw-row" /><span className="sw-row" /><span className="sw-button" /></span>
      </span>
    </span>
  );
}

export function PrefsDialog({ open, section, onSection, onClose, settings: s, appInfo, update, onChange, onCheckUpdate, onOpenLink }: {
  open: boolean;
  section: PrefsSection;
  onSection: (p: PrefsSection) => void;
  onClose: () => void;
  settings: Settings;
  appInfo: AppInfo | null;
  update: UpdateState;
  onChange: (s: Settings) => void;
  onCheckUpdate: () => void;
  onOpenLink: (l: Link) => void;
}) {
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
  const setUi = (patch: Partial<Settings["ui"]>) => onChange({ ...s, ui: { ...s.ui, ...patch } });
  const skinFixesTheme = s.ui.skin !== "studio";
  const r = update.result;

  return (
    <dialog ref={ref} className="prefs" aria-labelledby="prefs-title" onCancel={(e) => {
        // Échap : l'état de l'application décide de la fermeture (jamais le navigateur seul).
        e.preventDefault();
        onClose();
      }}
      // Fermée quand même par le navigateur (Échap répété, par exemple) : l'état suit.
      // L'événement « close » arrive en différé : s'il concerne une fermeture d'avant une
      // réouverture rapide (Ctrl+K juste après une commande), la fenêtre est de nouveau
      // ouverte et l'événement est ignoré.
      onClose={(e) => !e.currentTarget.open && onClose()}
      onClick={(e) => {
        // Un clic sur le fond (en dehors de la boîte) ferme la fenêtre.
        if (e.target === e.currentTarget) onClose();
      }}>
      <div className="prefs-box">
        <nav className="prefs-nav" aria-label="Preferences sections">
          <span className="prefs-brand" id="prefs-title">PREFERENCES</span>
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" className="prefs-nav-item" aria-current={section === id ? "page" : undefined}
              onClick={() => onSection(id)}>{label}</button>
          ))}
        </nav>
        <div className="prefs-body">
          <div className="prefs-head">
            <h2>{SECTIONS.find(([id]) => id === section)?.[1]}</h2>
            <button type="button" className="btn-mini" aria-label="Close the preferences" onClick={onClose}>×</button>
          </div>

          {section === "appearance" && (
            <>
              <div>
                <Choice label="THEME" value={s.ui.theme} options={[["dark", "Dark"], ["light", "Light"]]} disabled={skinFixesTheme}
                  onChange={(theme) => setUi({ theme })} />
                {skinFixesTheme && <p className="hint">The {SKINS.find((k) => k.id === s.ui.skin)?.name} skin sets its own light. Choose Studio to pick dark or light.</p>}
              </div>
              <div className="field">
                <span className="label">SKIN</span>
                <p className="hint">Applies instantly. The viewer, scopes and exported files are never tinted by a skin.</p>
                <div className="skin-grid" role="radiogroup" aria-label="Skin">
                  {SKINS.map((k) => (
                    <button key={k.id} type="button" role="radio" aria-checked={s.ui.skin === k.id} className="skin-card"
                      onClick={() => setUi({ skin: k.id })}>
                      <SkinSwatch skin={k.id} />
                      <span className="skin-card-text">
                        <span className={`skin-name skin-name-${k.id}`}>{k.name}</span>
                        <span className="skin-note">{k.note}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="label">ACCENT</span>
                <div className="accent-row" role="radiogroup" aria-label="Accent color">
                  {ACCENTS.map((a) => (
                    <button key={a.id} type="button" role="radio" aria-checked={s.ui.accent === a.id} disabled={skinFixesTheme}
                      className="accent-chip" data-chip={a.id} onClick={() => setUi({ accent: a.id })}>
                      <span className="accent-dot" aria-hidden />{a.name}
                    </button>
                  ))}
                </div>
                {skinFixesTheme && <p className="hint">The {SKINS.find((k) => k.id === s.ui.skin)?.name} skin has its own accent. Choose Studio to pick one.</p>}
              </div>
              <Toggle label="Skin decoration" checked={s.ui.effects} onChange={(effects) => setUi({ effects })}
                hint="Color bars, terminal line and texture. Off keeps only the colors." />
              <p className="hint">A skin changes colors, the label font, corners and decoration, never the layout: every panel stays where you know it.</p>
            </>
          )}

          {section === "analysis" && (
            <>
              <Choice label="ANALYSIS DECODER" value={s.shots.decoder}
                options={[["auto", "Auto"], ["gpu", `GPU (${GPU_NAME})`], ["cpu", "CPU"]]}
                onChange={(decoder) => onChange({ ...s, shots: { ...s.shots, decoder } })} />
              <p className="hint">Auto uses the GPU ({GPU_NAME}) when the file allows it and falls back to the CPU on failure. GPU forces it, without fallback.</p>
            </>
          )}

          {section === "updates" && (
            appInfo && !appInfo.updatesEnabled ? (
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
            )
          )}

          {section === "projects" && <ProjectsSection />}

          {section === "about" && (
            <>
              <p className="small">
                <strong>Photogramme {appInfo?.version ?? ""}</strong> · free software (GNU GPL v3) by Arnaud Guillard.
              </p>
              {appInfo?.kofi && (
                <div className="field">
                  <span className="label">SUPPORT</span>
                  <p className="small">Photogramme is free. If it saves you time, you can buy me a coffee.</p>
                  <button type="button" className="btn-kofi" onClick={() => onOpenLink("kofi")}>☕ Buy me a coffee on Ko-fi</button>
                </div>
              )}
              <div className="row wrap">
                <button type="button" className="btn-small" onClick={() => onOpenLink("repo")}>Source code</button>
                <button type="button" className="btn-small" onClick={() => onOpenLink("releases")}>Releases</button>
                <button type="button" className="btn-small" onClick={() => onOpenLink("issues")}>Report a problem</button>
              </div>
              {/* Ligne gérée par scripts/publish-public.ps1 : une seule ligne, sans « < » dans le texte. */}
              <p className="legal">Photogramme, copyright (c) 2026 Arnaud Guillard. Free software under the GNU GPL v3, provided without any warranty. It uses libraries from the FFmpeg project under the LGPLv3, and the Barlow, Instrument Sans, Archivo, Space Mono and IBM Plex fonts under the SIL Open Font License 1.1. Full licenses: LICENSE.txt, THIRD_PARTY_NOTICES.txt and THIRD_PARTY_LICENSES.txt {IS_MAC ? "inside the app (Photogramme.app/Contents/Resources)" : "in the installation folder"}.</p>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Projets : où est gardé le travail, et place prise par les analyses. */
function ProjectsSection() {
  const [size, setSize] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api.projectCacheSize().then(setSize).catch(() => {});
  }, []);
  return (
    <>
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
    </>
  );
}
