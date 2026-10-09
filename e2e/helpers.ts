import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

export { expect };

const pageErrors = new WeakMap<Page, string[]>();

/**
 * `test` de Playwright, plus un contrôle automatique après chaque test : aucune erreur
 * dans la console ni dans la page (clés React en double, exceptions…), même quand le
 * test ne les regarde pas.
 */
export const test = base.extend<{ cleanConsole: void }>({
  cleanConsole: [
    async ({ page }, use) => {
      await use();
      expect(pageErrors.get(page) ?? [], "errors in the console or the page").toEqual([]);
    },
    { auto: true },
  ],
});

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const FILM = readFileSync(here("./fixtures/film.webm"));
const THUMB = readFileSync(here("./fixtures/thumb.jpg"));

export interface E2EOpts {
  film?: boolean;
  analysis?: boolean;
  savedTab?: string | null;
  outputDir?: string | null;
  updates?: boolean;
  warnings?: string[];
  failCommand?: string | null;
  ui?: Partial<{ scopesOpen: boolean; scope: string; strip: string; theme: "dark" | "light"; skin: "studio" | "atomic" | "mission"; effects: boolean; accent: "gold" | "coral" | "teal" | "blue"; muted: boolean }>;
}

/** Ouvre l'application avec le faux backend ; collecte les erreurs de la console et de la page. */
export async function boot(page: Page, opts: E2EOpts = {}) {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.route("http://e2e.local/**", (route) => {
    const url = route.request().url();
    if (url.includes("/asset/") && /\.(mp4|mov|mkv|m4v)$/i.test(decodeURIComponent(url))) {
      return route.fulfill({ status: 200, contentType: "video/webm", body: FILM, headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" } });
    }
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: THUMB, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.addInitScript((o) => {
    (window as unknown as { __E2E_OPTS: unknown }).__E2E_OPTS = o;
  }, opts);
  await page.addInitScript({ path: here("./mock-tauri.js") });
  // Journal des notifications : elles s'effacent seules, un test lent les manquerait.
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = log;
    new MutationObserver(() => {
      for (const t of Array.from(document.querySelectorAll(".toast .toast-text"))) {
        const text = t.textContent ?? "";
        if (log[log.length - 1] !== text) log.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto("/");
  if (opts.film !== false) await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible({ timeout: 20_000 });
  else await expect(page.getByText("NO FILM LOADED")).toBeVisible({ timeout: 20_000 });
  return errors;
}

/** Une notification contenant `text` est apparue (même si elle s'est déjà effacée). */
export async function expectToast(page: Page, text: string | RegExp) {
  await expect.poll(async () => {
    const log = await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
    return log.some((t) => (typeof text === "string" ? t.includes(text) : text.test(t)));
  }, { timeout: 15_000, message: `toast ${text}` }).toBe(true);
}

/** Appels reçus par le faux backend. */
export async function calls(page: Page, cmd?: string): Promise<{ cmd: string; args: Record<string, unknown> }[]> {
  const all = await page.evaluate(() => (window as unknown as { __e2e: { calls: { cmd: string; args: Record<string, unknown> }[] } }).__e2e.calls);
  return cmd ? all.filter((c) => c.cmd === cmd) : all;
}

/** Derniers réglages enregistrés par l'interface côté « Rust ». */
export async function savedSettings(page: Page) {
  return page.evaluate(() => (window as unknown as { __e2e: { state: { settings: Record<string, any> } } }).__e2e.state.settings);
}

/** Attend que l'enregistrement différé des réglages (300 ms) soit parti. */
export async function waitSaved(page: Page, check: (s: Record<string, any>) => boolean) {
  await expect.poll(async () => check(await savedSettings(page)), { timeout: 5000 }).toBe(true);
}

/** Aucun élément ne déborde de la fenêtre, et la page ne défile pas. */
export async function expectNoOverflow(page: Page) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (el.closest("dialog:not([open])") || el.closest(".filmtabs-list") || el.closest(".viewer-stage.is-zoomed")) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // Ce qui est dans une zone qui défile est mesuré par rapport à elle, pas à la fenêtre.
      let p = el.parentElement;
      let clipped = false;
      while (p) {
        const o = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(o.overflowX + o.overflowY) && p !== document.body) {
          clipped = true;
          break;
        }
        p = p.parentElement;
      }
      if (clipped) continue;
      if (b.right > vw + 1 || b.bottom > vh + 1 || b.left < -1) bad.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    // Aucun panneau ne doit défiler à l'horizontale ni rogner son contenu en largeur
    // (sauf les textes coupés exprès avec « … » et la barre d'onglets de films).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (el.closest("dialog:not([open])") || el.closest(".viewer-stage.is-zoomed") || el.matches(".filmtabs-list, .viewer-stage, video, canvas")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || el.getClientRects().length === 0) continue;
      if (!/(auto|scroll|hidden|clip)/.test(cs.overflowX) || cs.textOverflow === "ellipsis") continue;
      if (el.scrollWidth - el.clientWidth > 1) bad.push(`clips horizontally: ${el.tagName.toLowerCase()}.${el.className} (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return { bad: bad.slice(0, 8), scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, vw, vh };
  });
  expect(r.bad, `elements outside the window: ${r.bad.join(" | ")}`).toEqual([]);
  expect(r.scrollW).toBeLessThanOrEqual(r.vw);
  expect(r.scrollH).toBeLessThanOrEqual(r.vh);
}
