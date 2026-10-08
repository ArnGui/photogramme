import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuration recommandée par Tauri : port fixe, pas de nettoyage d'écran
// (les erreurs Rust restent visibles), cible = Chromium de WebView2.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
  },
});
