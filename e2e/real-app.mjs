// Test de bout en bout de l'APPLICATION RÉELLE (Rust + FFmpeg + interface),
// pilotée par WebDriver via tauri-driver. Complète les tests Playwright
// (interface + faux backend) : ici rien n'est simulé, on vérifie les fichiers
// réellement écrits sur le disque.
//
// Prérequis (Linux) : webkit2gtk-driver, xvfb, `cargo install tauri-driver`,
//   l'application compilée (`npx tauri build --debug --no-bundle`), FFmpeg en sidecar.
// Windows : tauri-driver + msedgedriver (même script).
//
// Lancement : xvfb-run -a node e2e/real-app.mjs <application> <film.mp4>
// Sans dépendance : WebDriver parlé directement en HTTP.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [app, film] = process.argv.slice(2);
if (!app || !film) {
  console.error("usage: node e2e/real-app.mjs <application> <film.mp4>");
  process.exit(2);
}

const ROOT = mkdtempSync(join(tmpdir(), "photogramme-real-"));
const OUT = join(ROOT, "out");
const CONFIG = join(ROOT, "config");
const DATA = join(ROOT, "data");
for (const d of [OUT, CONFIG, DATA]) mkdirSync(d, { recursive: true });
const SETTINGS_DIR = join(CONFIG, "fr.arnaudguillard.photogramme");
mkdirSync(SETTINGS_DIR, { recursive: true });
// Réglages de départ : dossier de sortie connu, pas de requête réseau au démarrage.
writeFileSync(join(SETTINGS_DIR, "settings.json"), JSON.stringify({ outputDir: OUT, updates: { checkAtStartup: false } }));

const env = { ...process.env, XDG_CONFIG_HOME: CONFIG, XDG_DATA_HOME: DATA, XDG_CACHE_HOME: join(ROOT, "cache") };
const driver = spawn("tauri-driver", [], { env, stdio: ["ignore", "inherit", "inherit"] });
const W3C = "http://127.0.0.1:4444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
  console.log(results[results.length - 1]);
}

async function wd(method, path, body) {
  const r = await fetch(W3C + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j.value ?? j).slice(0, 300)}`);
  return j.value;
}

let sid;
const exec = (script, ...args) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
/** Attend qu'une expression JS (corps de fonction) renvoie une valeur vraie. */
async function waitFor(name, body, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await exec(body).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      check(name, false, "timed out");
      return null;
    }
    await sleep(250);
  }
}
const click = (selector) => exec(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true;`);
const clickText = (selector, text) => exec(`const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true;`);
/** Touche envoyée comme le ferait le clavier (keydown sur la fenêtre). */
const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: ${JSON.stringify(k)}, bubbles: true }, ${JSON.stringify(mods)}))); return true;`);
/** Capture d'écran du vrai rendu (WebKit) si REAL_SHOTS est un dossier. */
async function shot(name) {
  if (!process.env.REAL_SHOTS) return;
  mkdirSync(process.env.REAL_SHOTS, { recursive: true });
  writeFileSync(join(process.env.REAL_SHOTS, `${name}.png`), Buffer.from(await wd("GET", `/session/${sid}/screenshot`), "base64"));
}
const toastSeen = (text, timeout = 60_000) =>
  waitFor(`toast: ${text}`, `return [...document.querySelectorAll(".toast-text")].some((t) => t.textContent.includes(${JSON.stringify(text)}));`, timeout);
const files = (dir = OUT) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);
const settingsFile = () => JSON.parse(readFileSync(join(SETTINGS_DIR, "settings.json"), "utf8"));

async function launch() {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${W3C}/status`);
      break;
    } catch {
      await sleep(250);
    }
  }
  const s = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app, args: [film] } } },
  });
  sid = s.sessionId;
}

try {
  await launch();

  // 1. Le film passé en argument s'ouvre ; format lu par la vraie sonde FFmpeg.
  const meta = await waitFor("film opens from the command line", `const m = document.querySelector(".viewer-meta"); return m && m.textContent;`);
  check("probe: 1280×536 at 24 fps", !!meta && meta.includes("1280×536") && meta.includes("24"), meta ?? "");
  check("start timecode read from the file (01:00:00:00)", (await exec(`return document.querySelector(".tc-big").textContent`)) === "01:00:00:00");
  check("skin and theme applied", (await exec(`return document.documentElement.dataset.skin + "/" + document.documentElement.dataset.theme`)) === "studio/dark");

  // 2. Capture à l'unité avec le look (composition Canvas + encodage JPEG Rust).
  await key("ArrowRight");
  await key("ArrowRight");
  await key("c");
  await toastSeen("saved");
  const jpg1 = files().filter((f) => f.endsWith(".jpg"));
  check("capture writes a JPEG", jpg1.length === 1, jpg1.join(", "));
  if (jpg1[0]) {
    const b = readFileSync(join(OUT, jpg1[0]));
    check("capture is a real JPEG (FF D8 … FF D9)", b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9, `${b.length} bytes`);
  }

  // 3. Analyse réelle (FFmpeg scdet) : les 5 plans du film de test.
  await clickText("button", "Analyze the film");
  await toastSeen("Analysis done", 120_000);
  const shots = await waitFor("shot list appears", `const n = document.querySelectorAll(".shot").length; return n > 0 ? n : 0;`);
  check("scene detection finds the 5 shots", shots === 5, `${shots} shots`);
  const line = await exec(`return document.querySelector(".analysis-line")?.textContent ?? ""`);
  const status = await exec(`return document.querySelector(".statusbar")?.textContent ?? ""`);
  check("status bar names the decoder the analysis really used", line.includes("CPU") ? status.includes("Analyzed on the CPU") : status.includes("Analyzed on the GPU"), status.slice(0, 60));
  await shot("1-extract-studio");
  check("barcode strip shown", !!(await waitFor("barcode", `const i = document.querySelector(".barcode img"); return i && i.complete && i.naturalWidth > 0;`)));

  // 4. Export des plans avec le look : une image par plan + CSV, dans un sous-dossier.
  await click(".btn-capture");
  await toastSeen("frames exported", 120_000);
  const exported = files().filter((f) => /[\\/].*\.jpg$/.test(f));
  check("batch export writes one still per shot in a subfolder", exported.length === 5, exported.join(", "));
  check("batch export writes the CSV list", files().some((f) => f.endsWith(".csv")));
  check("gallery lists every still", (await exec(`return document.querySelector('[role=tab]:nth-child(2)').textContent`)).includes("6"));

  // 5. Planche contact PDF.
  await exec(`[...document.querySelectorAll('[aria-label="Output"] button')].find((b) => b.textContent === "Contact sheet").click(); return true;`);
  await waitFor("contact sheet button", `return [...document.querySelectorAll(".btn-capture")].some((b) => b.textContent.startsWith("Make the contact sheet") && !b.disabled);`);
  await click(".btn-capture");
  await toastSeen("Contact sheet saved", 120_000);
  const pdf = files().find((f) => f.endsWith(".pdf"));
  check("contact sheet PDF written", !!pdf && readFileSync(join(OUT, pdf)).subarray(0, 5).toString() === "%PDF-", pdf ?? "none");

  // 6. Code-barre (OUTPUT › BARCODE) et palette (GALLERY).
  await clickText("[role=tab]", "OUTPUT");
  await exec(`[...document.querySelectorAll("details.section")].find((d) => d.textContent.includes("BARCODE")).open = true; return true;`);
  await clickText("button", "Export barcode");
  await toastSeen("barcode", 60_000);
  check("barcode JPEG written", files().some((f) => /barcode/i.test(f) && f.endsWith(".jpg")));
  await clickText("[role=tab]", "GALLERY");
  await clickText("button", "Save this frame's palette");
  await toastSeen("Palette saved", 30_000);
  check("palette files written (.ase .css .gpl .json)", [".ase", ".css", ".gpl", ".json"].every((e) => files().some((f) => f.endsWith(e))));

  // 7. Aperçu d'export et scopes : pixels exacts reçus du Rust, dessinés.
  await key("p");
  const drawn = await waitFor("export preview drawn", `const c = document.querySelector(".preview-canvas"); if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4000) lit += d[i] + d[i + 1] + d[i + 2] > 30 ? 1 : 0; return lit;`);
  check("export preview shows the composed frame", (drawn ?? 0) > 50, `${drawn} lit samples`);
  await key("s");
  const scope = await waitFor("scopes drawn", `const c = document.querySelector(".scope-canvas canvas"); if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 400) lit += d[i] + d[i + 1] + d[i + 2] > 60 ? 1 : 0; return lit;`);
  check("waveform computed from the real frame", (scope ?? 0) > 20, `${scope} lit samples`);
  await clickText("[role=tab]", "LOOK");
  await sleep(800);
  await shot("2-look-scopes-studio");

  // 8. Préférences : skin enregistré côté Rust ; palette de commandes.
  await key(",", { ctrlKey: true });
  await waitFor("preferences open", `return !!document.querySelector("dialog.prefs[open]")`);
  await exec(`[...document.querySelectorAll(".skin-card")].find((b) => b.textContent.includes("Mission")).click(); return true;`);
  await sleep(300);
  await shot("3-prefs-mission");
  check("Mission skin applied", (await exec(`return document.documentElement.dataset.skin + "/" + document.documentElement.dataset.theme`)) === "mission/light");
  await key("Escape");
  await exec(`document.querySelector("dialog.prefs").dispatchEvent(new Event("cancel", { cancelable: true })); return true;`);
  await sleep(800);
  check("skin saved in settings.json by the Rust side", settingsFile().ui?.skin === "mission", JSON.stringify(settingsFile().ui));
  await key("k", { ctrlKey: true });
  await waitFor("command palette open", `return !!document.querySelector("dialog.palette[open]")`);
  await exec(`const i = document.querySelector(".palette-search input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(i, "skin atomic"); i.dispatchEvent(new Event("input", { bubbles: true })); return true;`);
  await sleep(200);
  await exec(`document.querySelector(".palette-item").click(); return true;`);
  await sleep(800);
  check("command palette runs a command (Skin: Atomic)", settingsFile().ui?.skin === "atomic");
  await clickText("[role=tab]", "EXTRACT");
  await sleep(600);
  await shot("4-extract-atomic");

  // 9. Le projet du film est enregistré : onglet, captures.
  await clickText("[role=tab]", "OUTPUT");
  await sleep(2500);
  const projects = files(DATA).filter((f) => f.endsWith(".json"));
  check("film project saved", projects.length > 0, projects.slice(0, 3).join(", "));

  // 10. Redémarrage : le film, l'onglet et le skin reviennent.
  await wd("DELETE", `/session/${sid}`);
  await sleep(1000);
  await launch();
  await waitFor("film reopens after a restart", `return !!document.querySelector(".viewer-meta")`);
  // Le projet est appliqué juste après l'affichage du film : on attend l'onglet enregistré,
  // et on note celui affiché si rien ne vient (sous charge, EXTRACT reste visible un instant).
  const tabNow = `const t = document.querySelector('[role=tab][aria-selected=true].tab'); return t && t.textContent;`;
  const t0 = Date.now();
  let restored = null;
  while (Date.now() - t0 < 10_000 && !(restored ?? "").includes("OUTPUT")) {
    restored = await exec(tabNow).catch(() => null);
    if (!(restored ?? "").includes("OUTPUT")) await sleep(250);
  }
  check("inspector tab restored (OUTPUT)", (restored ?? "").includes("OUTPUT"), `${restored ?? ""} after ${Date.now() - t0} ms`);
  check("skin restored (Atomic)", (await exec(`return document.documentElement.dataset.skin`)) === "atomic");
  check("captures restored in the gallery", ((await exec(`return document.querySelector('[role=tab].tab:nth-child(2)').textContent`)) ?? "").includes("6"));
  check("analysis restored (shot list without re-analyzing)", !!(await waitFor("analysis restored", `return document.querySelectorAll(".barcode img").length > 0 || !!document.querySelector(".shot")`, 20_000)));
  await wd("DELETE", `/session/${sid}`);
} catch (e) {
  check("scenario ran to the end", false, String(e).slice(0, 400));
} finally {
  driver.kill();
  console.log(`\n${results.length - failures}/${results.length} checks passed. Work folder: ${ROOT}`);
  if (!failures) rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

// Réutilise statSync pour éviter un avertissement d'import inutilisé dans certains éditeurs.
void statSync;
