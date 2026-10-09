import { defineConfig } from "@playwright/test";

// Tests d'interface : l'application tourne dans Chromium avec un faux backend
// Tauri (e2e/mock-tauri.js). CHROMIUM_PATH : navigateur à utiliser s'il n'est
// pas celui installé par `npx playwright install chromium`.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  outputDir: "e2e/.results",
  use: {
    baseURL: "http://127.0.0.1:5199",
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    // Adresse imposée : sur les runners Ubuntu de GitHub, « localhost » est ::1 (IPv6)
    // et Vite n'écouterait que là, alors que les tests visent 127.0.0.1.
    command: "npx vite --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
