// Thème de l'interface. Les réglages (côté Rust) font foi ; une copie locale
// permet de l'appliquer avant même que les réglages soient chargés.

import type { Theme } from "./types";

const KEY = "photogramme.theme";

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* stockage indisponible : le thème s'appliquera après chargement des réglages */
  }
}
