import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
// Interface (v0.7) : Instrument Sans ; étiquettes des skins Atomic (Space Mono) et Mission (Archivo).
// Toutes embarquées : l'application ne charge rien depuis le réseau.
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "./styles.css";
import App from "./App";
import { api } from "./api";
import { CrashScreen } from "./CrashScreen";
import { applyAppearance, savedAppearance } from "./theme";

// Apparence posée avant le premier rendu : pas d'éclair de la mauvaise couleur au lancement.
applyAppearance(savedAppearance());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);

// Signe de vie pour le guetteur Rust : si le moteur de la fenêtre s'arrête (mémoire),
// le Rust affiche un message natif au lieu d'une fenêtre noire.
const beat = () => void api.heartbeat(document.visibilityState === "visible").catch(() => {});
beat();
setInterval(beat, 2000);
document.addEventListener("visibilitychange", beat);

// The app window must never scroll: only inner panels scroll.
window.addEventListener("scroll", () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}, { passive: true });
