/**
 * Différences d'interface entre Windows et macOS.
 *
 * La plateforme est lue dans l'agent utilisateur de la WebView (WebView2 sous
 * Windows, WKWebView sur Mac, qui annonce « Macintosh »). Pas de commande Rust
 * ni de permission en plus : ces valeurs ne servent qu'à l'affichage et aux
 * raccourcis clavier.
 */

export const IS_MAC = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Décodeur vidéo du GPU utilisé par l'analyse (même nom que côté Rust). */
export const GPU_NAME = IS_MAC ? "VideoToolbox" : "NVDEC";

/** Gestionnaire de fichiers du système. */
export const FILE_MANAGER = IS_MAC ? "Finder" : "Explorer";

/** Libellé d'un raccourci : « ⌘O » sur Mac, « Ctrl+O » sous Windows. */
export function shortcut(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

/** Touche de commande du système enfoncée (⌘ sur Mac, Ctrl ailleurs). */
export function hasCommandKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** Polices courantes du système, proposées en plus des polices embarquées. */
export const SYSTEM_FONTS: readonly string[] = IS_MAC
  ? [
      "American Typewriter", "Arial", "Arial Narrow", "Avenir", "Avenir Next", "Avenir Next Condensed", "Baskerville",
      "Courier New", "Didot", "Futura", "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Impact", "Menlo",
      "Optima", "Palatino", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
    ]
  : [
      "Arial", "Arial Narrow", "Bahnschrift", "Calibri", "Cambria", "Candara", "Consolas", "Constantia",
      "Corbel", "Courier New", "Franklin Gothic Medium", "Georgia", "Impact", "Segoe UI", "Segoe UI Light",
      "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
    ];
