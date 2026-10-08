import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import App from "./App";
import { applyTheme, savedTheme } from "./theme";

// Thème posé avant le premier rendu : pas d'éclair sombre au lancement en thème clair.
applyTheme(savedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The app window must never scroll: only inner panels scroll.
window.addEventListener("scroll", () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}, { passive: true });
