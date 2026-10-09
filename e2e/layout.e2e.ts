// Mise en page et apparence : chaque skin × thème × taille de fenêtre × onglet.
// Rien ne déborde, rien ne casse, la scène de l'image reste neutre partout,
// et les contrastes des textes tiennent (WCAG 2.x : 4,5:1).

import { boot, expectNoOverflow, expect, test } from "./helpers";

const LOOKS = [
  { name: "studio-dark", ui: { skin: "studio", theme: "dark" } },
  { name: "studio-light", ui: { skin: "studio", theme: "light" } },
  { name: "atomic", ui: { skin: "atomic", theme: "light" } }, // le thème est ignoré : Atomic est sombre
  { name: "mission", ui: { skin: "mission", theme: "dark" } }, // Mission est clair
] as const;
const SIZES = [
  { name: "min", width: 1024, height: 680 }, // taille minimale de la fenêtre (tauri.conf.json)
  { name: "default", width: 1440, height: 900 },
  { name: "full-hd", width: 1920, height: 1080 },
];
const TABS = ["EXTRACT", "GALLERY", "LOOK", "OUTPUT"];

for (const look of LOOKS) {
  for (const size of SIZES) {
    test(`${look.name} @ ${size.name}: every tab fits the window, no error`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const errors = await boot(page, { analysis: true, ui: { ...look.ui, scopesOpen: size.name !== "min" } });
      for (const t of TABS) {
        await page.getByRole("tab", { name: t }).click();
        await page.waitForTimeout(250);
        await expectNoOverflow(page);
        if (size.name === "default") await page.screenshot({ path: `e2e/.results/screens/${look.name}-${t.toLowerCase()}.png` });
      }
      expect(errors).toEqual([]);
    });
  }

  test(`${look.name}: the image stage stays neutral and the skin is applied`, async ({ page }) => {
    await boot(page, { analysis: true, ui: { ...look.ui, scopesOpen: true } });
    const r = await page.evaluate(() => {
      const root = document.documentElement;
      const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
      return {
        skin: root.dataset.skin, theme: root.dataset.theme,
        stage: bg(".viewer-stage"), box: bg(".viewer-box"), scope: getComputedStyle(document.querySelector(".scope-canvas canvas")!).backgroundColor,
      };
    });
    expect(r.skin).toBe(look.ui.skin);
    expect(r.theme).toBe(look.ui.skin === "atomic" ? "dark" : look.ui.skin === "mission" ? "light" : look.ui.theme);
    // Même gris neutre (R = G = B) dans tous les skins.
    expect(r.stage).toBe("rgb(21, 21, 21)");
    expect(r.box).toBe("rgb(0, 0, 0)");
    expect(r.scope).toBe("rgb(0, 0, 0)");
  });

  test(`${look.name}: text contrast meets WCAG AA`, async ({ page }) => {
    await boot(page, { analysis: true, ui: look.ui });
    const pairs = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (n: string) => css.getPropertyValue(n).trim();
      const rgb = (hex: string) => {
        const h = hex.replace("#", "");
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      };
      const lum = (hex: string) => {
        const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const out: [string, number][] = [];
      for (const bg of ["--panel", "--panel-2", "--surface", "--bg"]) {
        for (const fg of ["--text", "--text-2", "--text-3"]) out.push([`${fg} on ${bg}`, ratio(v(fg), v(bg))]);
      }
      out.push(["--accent-ink on --panel", ratio(v("--accent-ink"), v("--panel"))]);
      out.push(["--on-accent on --accent", ratio(v("--on-accent"), v("--accent"))]);
      out.push(["--text on --seg-on", ratio(v("--text"), v("--seg-on"))]);
      out.push(["--gpu on --panel", ratio(v("--gpu"), v("--panel"))]);
      return out;
    });
    const failing = pairs.filter(([, r]) => r < 4.5).map(([n, r]) => `${n}: ${r.toFixed(2)}`);
    expect(failing, failing.join(", ")).toEqual([]);
  });
}

test("the empty state fits the smallest window in every skin", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  for (const skin of ["studio", "atomic", "mission"] as const) {
    const errors = await boot(page, { film: false, ui: { skin } });
    await expectNoOverflow(page);
    await page.screenshot({ path: `e2e/.results/screens/empty-${skin}.png` });
    expect(errors).toEqual([]);
  }
});

test("every control has an accessible name", async ({ page }) => {
  await boot(page, { analysis: true, ui: { scopesOpen: true } });
  for (const t of TABS) {
    await page.getByRole("tab", { name: t }).click();
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea, [role=slider], [role=tab], [role=option]"))
        .filter((el) => !el.closest("dialog:not([open])") && el.getClientRects().length > 0)
        .filter((el) => {
          const label = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el as HTMLInputElement).labels?.length || el.textContent?.trim() || el.getAttribute("title");
          return !label;
        })
        .map((el) => el.outerHTML.slice(0, 120)));
    expect(unnamed, `${t}: ${unnamed.join("\n")}`).toEqual([]);
  }
});
