// Visionneuse, transport, timeline et raccourcis clavier.

import { boot, calls, savedSettings, waitSaved, expectToast, expect, test } from "./helpers";

const tcText = (page: import("@playwright/test").Page) => page.locator(".tc-big").textContent();

test("transport buttons and arrow keys move frame by frame and by the second", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:00");
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:01");
  await page.getByRole("button", { name: "Forward one second" }).click();
  await expect(page.locator(".tc-big")).toHaveText("01:00:01:01");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".tc-big")).toHaveText("01:00:01:02");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:02");
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Previous frame" }).click();
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:00");
  await page.keyboard.press("End");
  await expect(page.locator(".tc-big")).toHaveText("01:00:09:23");
  await expect(page.getByText("Frame 240 / 240")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:00");
  expect(errors).toEqual([]);
});

test("play / pause with the button and the space bar", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(() => tcText(page)).not.toBe("01:00:00:00");
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("in / out marks: buttons, I / O keys, Alt+X, and the export plan follows the range", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  await expect(page.locator(".mark-tc").first()).toHaveText("01:00:00:01");
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Mark out" }).click();
  await expect(page.locator(".mark-tc").nth(1)).toHaveText("01:00:01:01");
  await expect(page.locator(".range-mark.in")).toBeVisible();
  await expect(page.locator(".range-mark.out")).toBeVisible();
  await expect(page.getByText(/In 01:00:00:01 · Out 01:00:01:01/)).toBeVisible();
  await expect.poll(async () => (await calls(page, "batch_plan")).some((c) => (c.args.range as { start: number } | null)?.start === 1)).toBe(true);
  await page.keyboard.press("Alt+x");
  await expect(page.locator(".mark-tc").first()).toHaveText("--:--:--:--");
  await expect(page.locator(".range-mark")).toHaveCount(0);
  // Bouton « Clear » du transport.
  await page.getByRole("button", { name: "Mark in" }).click();
  await page.locator(".transport-marks").getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".mark-tc").first()).toHaveText("--:--:--:--");
});

test("C captures with the look burnt in, then without it", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.keyboard.press("c");
  await expect.poll(async () => (await calls(page, "write_composed")).length).toBe(1);
  expect((await calls(page, "grab_frame")).length).toBeGreaterThan(0);
  await expectToast(page, "saved");
  // Look off → capture brute par le Rust.
  await page.getByRole("tab", { name: "LOOK" }).click();
  // L'interrupteur est une vraie case à cocher (cachée sous son dessin) : on clique son libellé.
  await page.locator("label.toggle", { hasText: "Apply the look to exported stills" }).click();
  await waitSaved(page, (s) => s.export.overlay === false);
  await page.getByRole("button", { name: /^Capture/ }).click();
  await expect.poll(async () => (await calls(page, "capture")).length).toBe(1);
  await page.getByRole("tab", { name: /GALLERY/ }).click();
  await expect(page.locator(".thumb")).toHaveCount(2);
});

test("P, Z, R, W and S drive the viewer tools and stay in sync with the toolbar", async ({ page }) => {
  await boot(page, { analysis: true });
  const tools = page.getByRole("toolbar", { name: "Viewer tools" });
  // P : aperçu d'export (composition exacte sur un canvas).
  await page.keyboard.press("p");
  await expect(tools.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".preview-badge")).toBeVisible();
  await expect(page.locator(".preview-canvas")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.locator(".preview-badge")).toHaveCount(0);
  // Z : fit → 100 % → 200 % → fit.
  const zoom = page.getByLabel("Zoom");
  await page.keyboard.press("z");
  await expect(zoom).toHaveValue("1");
  await page.keyboard.press("z");
  await expect(zoom).toHaveValue("2");
  await zoom.selectOption("fit");
  await expect(zoom).toHaveValue("fit");
  // R : référence A, le volet s'allume ; W l'éteint et le rallume.
  await expect(tools.getByRole("button", { name: "Wipe" })).toBeDisabled();
  await page.keyboard.press("r");
  await expect(tools.getByRole("button", { name: "Wipe" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "A/B wipe position" })).toBeVisible();
  await page.keyboard.press("w");
  await expect(page.getByRole("slider", { name: "A/B wipe position" })).toHaveCount(0);
  await tools.getByRole("button", { name: "Wipe" }).click();
  const wipe = page.getByRole("slider", { name: "A/B wipe position" });
  await wipe.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(wipe).toHaveAttribute("aria-valuenow", "45");
  // S : scopes, choix de l'instrument enregistré.
  await page.keyboard.press("s");
  await expect(page.getByRole("complementary", { name: "Scopes" })).toBeVisible();
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Parade" }).click();
  await waitSaved(page, (s) => s.ui.scope === "parade" && s.ui.scopesOpen === true);
  await tools.getByRole("button", { name: "Scopes" }).click();
  await expect(page.getByRole("complementary", { name: "Scopes" })).toHaveCount(0);
  await waitSaved(page, (s) => s.ui.scopesOpen === false);
});

test("the image is never stretched: video, preview canvas and reference keep their ratio", async ({ page }) => {
  await boot(page, { analysis: true });
  const ratio = (sel: string) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width / r.height;
  });
  expect(Math.abs((await ratio(".viewer-box")) - 1280 / 536)).toBeLessThan(0.01);
  await page.keyboard.press("p");
  await expect(page.locator(".preview-canvas")).toBeVisible();
  // La boîte prend le ratio de la composition (marges + bande) ; le canvas garde ses pixels (object-fit: contain).
  const comp = await page.locator(".preview-canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  expect(Math.abs((await ratio(".viewer-box")) - comp.w / comp.h)).toBeLessThan(0.01);
  expect(await page.locator(".preview-canvas").evaluate((c) => getComputedStyle(c).objectFit)).toBe("contain");
  // On change les marges dans LOOK : le ratio suit, sans étirement.
  await page.getByRole("tab", { name: "LOOK" }).click();
  const bottom = page.getByRole("textbox", { name: "Bottom margin" });
  await bottom.fill("400");
  await bottom.press("Enter");
  await expect.poll(async () => page.locator(".preview-canvas").evaluate((c: HTMLCanvasElement) => c.height)).toBeGreaterThan(comp.h);
  const comp2 = await page.locator(".preview-canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  await expect.poll(async () => Math.abs((await ratio(".viewer-box")) - comp2.w / comp2.h)).toBeLessThan(0.01);
});

test("timeline: the slider seeks, the barcode click seeks, and the strip switch is saved", async ({ page }) => {
  await boot(page, { analysis: true });
  const slider = page.getByRole("slider", { name: "Position in the film" });
  await slider.focus();
  await page.keyboard.press("End");
  await expect(page.locator(".tc-big")).toHaveText("01:00:09:23");
  const bar = page.getByRole("button", { name: /Film barcode/ });
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => Number((await tcText(page))!.split(":")[2])).toBeGreaterThanOrEqual(4);
  const strip = page.getByRole("group", { name: "Strip above the timeline" });
  await strip.getByRole("button", { name: "Frames" }).click();
  await expect(page.getByRole("button", { name: /Film frames/ })).toBeVisible();
  await waitSaved(page, (s) => s.ui.strip === "frames");
  await strip.getByRole("button", { name: "Off" }).click();
  await expect(page.locator(".barcode")).toHaveCount(0);
  await waitSaved(page, (s) => s.ui.strip === "off");
});

test("without analysis the strip switch is disabled and says why", async ({ page }) => {
  await boot(page, { analysis: false });
  const strip = page.getByRole("group", { name: "Strip above the timeline" });
  await expect(strip.getByRole("button", { name: "Barcode" })).toBeDisabled();
  await expect(strip.getByRole("button", { name: "Barcode" })).toHaveAttribute("title", /Analyze the film/);
});

test("shortcuts are ignored while typing in a field", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("tab", { name: "LOOK" }).click();
  await page.getByRole("option", { name: /Title/ }).click();
  const text = page.getByLabel("TEXT", { exact: true });
  await text.fill("c p s z");
  await expect(page.locator(".preview-badge")).toBeVisible(); // LOOK allume l'aperçu, la touche p tapée ne l'a pas éteint
  expect((await calls(page, "capture")).length + (await calls(page, "write_composed")).length).toBe(0);
  expect((await savedSettings(page)).ui.scopesOpen).toBe(false);
});

test("stepping forward never shows the previous frame number for an instant", async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, { analysis: true });
  // Un rappel d'image en route pendant un déplacement ramenait le numéro en arrière
  // (N+1 → N → N+1) : un I, O ou C tapé à ce moment visait la mauvaise image.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    const read = () => {
      const m = /FRAME (\d+)/.exec(document.querySelector(".tc-sub")?.textContent ?? "");
      if (m && w.__frames[w.__frames.length - 1] !== +m[1]) w.__frames.push(+m[1]);
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  });
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("ArrowRight");
    if (i % 3 === 2) await page.keyboard.press("Home");
  }
  await page.waitForTimeout(500);
  const f = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames);
  const bounces = f.flatMap((n, i) => (i >= 2 && n < f[i - 1] && n === f[i - 2] && n !== 1 ? [f.slice(i - 2, i + 1).join("→")] : []));
  expect(bounces).toEqual([]);
  expect(f[f.length - 1]).toBe(1);
});

// Régression v0.7 : en mode strict, J lançait deux minuteries de marche arrière ;
// l'une restait orpheline et K, les flèches ou un clic ne l'arrêtaient plus.
test("J / K / L shuttle: K stops reverse, and Home or a step cancels it too", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  await page.keyboard.press("End");
  await expect(page.locator(".tc-big")).toHaveText("01:00:09:23");
  await page.keyboard.press("j");
  await expect.poll(() => tcText(page)).not.toBe("01:00:09:23");
  await page.keyboard.press("j");
  await expect(page.locator(".shuttle")).toHaveText("◀ ×2");
  await page.keyboard.press("k");
  await expect(page.locator(".shuttle")).toHaveCount(0);
  const stopped = await tcText(page);
  await page.waitForTimeout(400);
  expect(await tcText(page)).toBe(stopped);

  // Une nouvelle marche arrière, coupée par Début.
  await page.keyboard.press("End");
  await page.keyboard.press("j");
  await expect.poll(() => tcText(page)).not.toBe("01:00:09:23");
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:00");

  // Puis coupée par une flèche : l'image suivante doit tenir.
  await page.keyboard.press("End");
  await page.keyboard.press("j");
  await expect.poll(() => tcText(page)).not.toBe("01:00:09:23");
  await page.keyboard.press("ArrowRight");
  const after = await tcText(page);
  await page.waitForTimeout(400);
  expect(await tcText(page)).toBe(after);

  // Puis coupée par un clic sur la timeline (code-barres) : le curseur ne doit plus reculer.
  await page.keyboard.press("End");
  await page.keyboard.press("j");
  await expect.poll(() => tcText(page)).not.toBe("01:00:09:23");
  const bar = page.getByRole("button", { name: /Film barcode/ });
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const clicked = await tcText(page);
  await page.waitForTimeout(400);
  expect(await tcText(page)).toBe(clicked);

  // L puis K : lecture avant arrêtée.
  await page.keyboard.press("l");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("M and the speaker button mute the viewer, and the choice is saved", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  const muted = () => page.locator("video").evaluate((v: HTMLVideoElement) => v.muted);
  expect(await muted()).toBe(false);
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
  expect(await muted()).toBe(true);
  await waitSaved(page, (s) => s.ui.muted === true);
  await page.getByRole("button", { name: "Unmute" }).click();
  expect(await muted()).toBe(false);
  expect(errors).toEqual([]);
});

// Régression v0.7 : à la pause, l'aperçu d'export de l'image d'avant la lecture restait
// affiché le temps du décodage FFmpeg (plusieurs secondes sur un GOP long).
test("with the export preview on, pausing never shows a stale preview", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  await page.keyboard.press("p");
  await expect(page.locator(".preview-canvas")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __grabDelay: number }).__grabDelay = 1500));
  await page.keyboard.press(" ");
  await expect.poll(() => tcText(page)).not.toBe("01:00:00:00");
  await page.keyboard.press(" ");
  // Pendant le calcul : la vidéo, déjà sur la bonne image, reste visible.
  await expect(page.locator(".preview-badge.is-loading")).toBeVisible();
  await expect(page.locator("video")).toBeVisible();
  // Puis l'aperçu à jour la remplace.
  await expect(page.locator(".preview-badge.is-loading")).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator("video")).toBeHidden();
  expect(errors).toEqual([]);
});
