// Apparence de l'interface : thème (clair/sombre) et skin. Les réglages (côté
// Rust) font foi ; une copie locale permet de l'appliquer avant même que les
// réglages soient chargés (pas d'éclair de la mauvaise couleur au lancement).
//
// Un skin ne fait que remplacer des variables CSS (couleurs, police des
// étiquettes, rayons, décor) : jamais la mise en page, jamais la visionneuse,
// les scopes ni les fichiers exportés.

import type { Accent, Skin, Theme } from "./types";

const KEY = "photogramme.appearance";
/** Clé de la v0.6 (thème seul), relue une fois pour ne pas perdre le choix. */
const OLD_KEY = "photogramme.theme";

export interface Appearance {
  theme: Theme;
  skin: Skin;
  effects: boolean;
  /** Accent du skin Studio (les autres skins gardent le leur). */
  accent: Accent;
}

/** Accents proposés dans Apparence. L'or (versions 0.5) est le réglage par défaut. */
export const ACCENTS: { id: Accent; name: string }[] = [
  { id: "gold", name: "Gold" },
  { id: "coral", name: "Coral" },
  { id: "teal", name: "Teal" },
  { id: "blue", name: "Blue" },
];
const isAccent = (x: unknown): x is Accent => ACCENTS.some((a) => a.id === x);

export const SKINS: { id: Skin; name: string; note: string; theme: Theme | null }[] = [
  { id: "studio", name: "Studio", note: "Default · dark or light", theme: null },
  { id: "atomic", name: "Atomic", note: "50s terminal · dark", theme: "dark" },
  { id: "mission", name: "Mission", note: "Cream · light", theme: "light" },
];

const isSkin = (x: unknown): x is Skin => x === "studio" || x === "atomic" || x === "mission";

/** Thème réellement affiché : un skin autre que Studio impose sa luminosité. */
export function effectiveTheme(a: Appearance): Theme {
  return SKINS.find((s) => s.id === a.skin)?.theme ?? a.theme;
}

/** Relit une apparence enregistrée localement, avec méfiance. */
export function parseAppearance(raw: string | null, legacyTheme: string | null): Appearance {
  const fallback: Appearance = { theme: legacyTheme === "light" ? "light" : "dark", skin: "studio", effects: true, accent: "gold" };
  if (!raw) return fallback;
  try {
    const x = JSON.parse(raw) as Partial<Record<keyof Appearance, unknown>>;
    return {
      theme: x.theme === "light" ? "light" : "dark",
      skin: isSkin(x.skin) ? x.skin : "studio",
      effects: x.effects !== false,
      accent: isAccent(x.accent) ? x.accent : "gold",
    };
  } catch {
    return fallback;
  }
}

export function savedAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(KEY), localStorage.getItem(OLD_KEY));
  } catch {
    return { theme: "dark", skin: "studio", effects: true, accent: "gold" };
  }
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = effectiveTheme(a);
  root.dataset.skin = a.skin;
  root.dataset.effects = a.effects ? "on" : "off";
  root.dataset.accent = a.accent;
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* stockage indisponible : l'apparence s'appliquera après chargement des réglages */
  }
}
