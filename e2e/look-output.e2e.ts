// Onglets LOOK (calques de l'overlay) et OUTPUT (fichiers).

import { boot, calls, savedSettings, waitSaved, expectToast, expect, test } from "./helpers";

test.describe("LOOK", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, { analysis: true });
    await page.getByRole("tab", { name: "LOOK" }).click();
  });

  test("opening LOOK turns the export preview on", async ({ page }) => {
    await expect(page.locator(".preview-badge")).toBeVisible();
    await expect(page.locator(".preview-canvas")).toBeVisible();
  });

  test("selecting a layer shows its properties; every layer opens", async ({ page }) => {
    const layers = page.getByRole("listbox", { name: "Layers" }).getByRole("option");
    await expect(layers).toHaveCount(5); // cadre, bande, scope, 2 textes du préréglage Cinema
    await layers.filter({ hasText: "Frame" }).click();
    await expect(page.getByRole("textbox", { name: "Top margin" })).toBeVisible();
    await layers.filter({ hasText: "Palette band" }).click();
    await expect(page.getByRole("textbox", { name: "Number of colors" })).toBeVisible();
    await expect(page.getByRole("group", { name: "WEIGHTING" })).toBeVisible();
    await layers.filter({ hasText: "Scope" }).click();
    await expect(page.locator("label.toggle", { hasText: "Burn a scope into the image" })).toBeVisible();
    await layers.filter({ hasText: "Timecode" }).click();
    await expect(page.getByLabel("TEXT", { exact: true })).toHaveValue("{tc}");
    // Au clavier aussi.
    await layers.filter({ hasText: "Title" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("TEXT", { exact: true })).toHaveValue("{film}");
  });

  test("the eye hides and shows a layer, and it is saved", async ({ page }) => {
    await page.getByRole("button", { name: "Hide Palette band" }).click();
    await waitSaved(page, (s) => s.overlay.palette.enabled === false);
    await page.getByRole("button", { name: "Show Palette band" }).click();
    await waitSaved(page, (s) => s.overlay.palette.enabled === true);
    await page.getByRole("button", { name: "Show Scope" }).click();
    await waitSaved(page, (s) => s.overlay.scope.enabled === true);
    await page.getByRole("button", { name: "Hide Timecode" }).click();
    await waitSaved(page, (s) => s.overlay.texts[1].enabled === false);
  });

  test("palette analysis settings live on the palette layer", async ({ page }) => {
    await page.getByRole("option", { name: /Palette band/ }).click();
    const count = page.getByRole("textbox", { name: "Number of colors" });
    await count.fill("9");
    await count.press("Enter");
    await page.getByRole("group", { name: "WEIGHTING" }).getByRole("button", { name: "Favor accents" }).click();
    await page.getByRole("group", { name: "ORDER" }).getByRole("button", { name: "Hue" }).click();
    await page.locator("label.toggle", { hasText: "Ignore black bars" }).click();
    await waitSaved(page, (s) => s.palette.count === 9 && s.palette.weighting === "accents" && s.palette.sort === "hue" && !s.palette.ignoreBars);
    await expect(page.getByRole("option", { name: /Palette band/ })).toContainText("9 colors");
  });

  test("edit a text layer: template, size, anchor, region, box; the preview redraws", async ({ page }) => {
    await page.getByRole("option", { name: /Timecode/ }).click();
    const grabs = (await calls(page, "grab_frame")).length;
    const before = await page.locator(".preview-canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL().length);
    await page.getByLabel("TEXT", { exact: true }).fill("{tc} · {frame}");
    const size = page.getByRole("textbox", { name: "Size" }).first();
    await size.fill("40");
    await size.press("Enter");
    await page.getByRole("button", { name: "Bottom right" }).click();
    await page.getByRole("group", { name: "RELATIVE TO" }).getByRole("button", { name: "Film frame" }).click();
    await page.locator("label.toggle", { hasText: "Background box" }).click();
    await expect(page.getByLabel("BOX COLOR", { exact: true })).toBeVisible();
    await waitSaved(page, (s) => {
      const t = s.overlay.texts[1];
      return t.template === "{tc} · {frame}" && t.font.size === 40 && t.anchor === "bottomRight" && t.region === "image" && t.boxEnabled;
    });
    await expect.poll(() => page.locator(".preview-canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL().length)).not.toBe(before);
    // Les réglages de texte ne relisent pas l'image : la composition est refaite sur place.
    expect((await calls(page, "grab_frame")).length - grabs).toBeLessThanOrEqual(2);
  });

  test("add a text (selected at once), then remove it", async ({ page }) => {
    await page.getByRole("button", { name: "+ Text" }).click();
    const layers = page.getByRole("listbox", { name: "Layers" }).getByRole("option");
    await expect(layers).toHaveCount(6);
    await expect(layers.last()).toHaveAttribute("aria-selected", "true");
    await waitSaved(page, (s) => s.overlay.texts.length === 3);
    await page.getByRole("button", { name: "Remove this text" }).click();
    await expect(layers).toHaveCount(5);
    await expect(page.locator(".layer.is-selected")).toHaveCount(1);
    await waitSaved(page, (s) => s.overlay.texts.length === 2);
  });

  test("presets: load, modify, save as, delete", async ({ page }) => {
    await page.getByLabel("Preset", { exact: true }).selectOption("Grading check");
    await expect(page.getByRole("listbox", { name: "Layers" }).getByRole("option")).toHaveCount(4);
    await waitSaved(page, (s) => s.overlay.name === "Grading check");
    await page.getByRole("option", { name: /Frame/ }).click();
    const top = page.getByRole("textbox", { name: "Top margin" });
    await top.fill("12");
    await top.press("Enter");
    await expect(page.getByText("Modified since the preset was loaded.")).toBeVisible();
    await page.getByLabel("Preset name").fill("Festival");
    await page.getByRole("button", { name: "Save as" }).click();
    await expect.poll(async () => (await calls(page, "save_preset")).length).toBe(1);
    await expectToast(page, 'Preset "Festival" saved');
    await expect(page.getByLabel("Preset", { exact: true })).toHaveValue("Festival");
    await page.getByRole("button", { name: "Delete" }).click();
    await expect.poll(async () => (await calls(page, "delete_preset")).length).toBe(1);
    await page.getByRole("button", { name: "Open the presets folder" }).click();
    await expect.poll(async () => (await calls(page, "open_presets_folder")).length).toBe(1);
  });

  test("look off: the preview says it is not burnt into the exports", async ({ page }) => {
    await page.locator("label.toggle", { hasText: "Apply the look to exported stills" }).click();
    await expect(page.locator(".preview-note")).toContainText("LOOK OFF IN EXPORTS");
    await waitSaved(page, (s) => s.export.overlay === false);
    // Les lettres restent des raccourcis après un clic sur un interrupteur (défaut de la v0.6).
    await page.keyboard.press("p");
    await expect(page.locator(".preview-badge")).toHaveCount(0);
  });
});

test.describe("OUTPUT", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, { analysis: true });
    await page.getByRole("tab", { name: "OUTPUT" }).click();
  });

  test("destination: choose and show the folder", async ({ page }) => {
    await page.getByRole("button", { name: /D:\\Films\\Atelier\\stills/ }).click();
    await expect.poll(async () => (await calls(page, "pick_output_dir")).length).toBe(1);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect.poll(async () => (await calls(page, "open_folder")).length).toBe(1);
  });

  test("stills: format, quality, chroma, color, timecode, subfolder, CSV", async ({ page }) => {
    const q = page.getByRole("textbox", { name: "JPEG quality" });
    await q.fill("97");
    await q.press("Enter");
    await expect(page.getByText("Visually near-lossless")).toBeVisible();
    await page.getByRole("group", { name: "CHROMA SUBSAMPLING" }).getByRole("button", { name: "4:2:0" }).click();
    await page.getByRole("group", { name: "COLOR" }).getByRole("button", { name: "Convert to sRGB" }).click();
    await expect(page.getByText(/Converted from gamma 2.4 to sRGB/)).toBeVisible();
    await page.getByRole("group", { name: "TIMECODE" }).getByRole("button", { name: "From 00:00:00:00" }).click();
    await expect(page.locator(".tc-big")).toHaveText("00:00:00:00");
    await page.locator("label.toggle", { hasText: "Add each frame's palette to the CSV" }).click();
    await page.locator("label.toggle", { hasText: "Batch exports in a subfolder" }).click();
    await waitSaved(page, (s) => s.quality === 97 && s.chroma === "4:2:0" && s.export.color === "srgb" && s.export.timecode === "zero"
      && s.export.csvPalette && !s.export.subfolder);
    await page.locator("label.toggle", { hasText: "Write a CSV list" }).click();
    await expect(page.locator("label.toggle", { hasText: "Add each frame's palette to the CSV" })).toHaveCount(0);
    await page.getByRole("group", { name: "FORMAT" }).first().getByRole("button", { name: "PNG (lossless)" }).click();
    await expect(page.getByRole("textbox", { name: "JPEG quality" })).toHaveCount(0);
    await waitSaved(page, (s) => s.export.format === "png" && !s.export.csv);
    await page.getByRole("tab", { name: "EXTRACT" }).click();
    await expect(page.getByRole("button", { name: /PNG still/ })).toBeVisible();
  });

  test("contact sheet section: summary, every setting saved", async ({ page }) => {
    const section = page.locator("details.section", { hasText: "CONTACT SHEET" });
    await expect(section.locator(".section-summary")).toHaveText("PDF · A4 · 4 col · light");
    await section.locator("summary").click();
    await section.getByRole("group", { name: "PAGE" }).getByRole("button", { name: "One image" }).click();
    await expect(section.getByRole("textbox", { name: "Image width" })).toBeVisible();
    await section.getByRole("group", { name: "PAGE" }).getByRole("button", { name: "A3" }).click();
    await section.locator("label.toggle", { hasText: "Landscape" }).click();
    await section.getByRole("group", { name: "RESOLUTION" }).getByRole("button", { name: "300 dpi" }).click();
    const cols = section.getByRole("textbox", { name: "Columns" });
    await cols.fill("6");
    await cols.press("Enter");
    await section.getByRole("group", { name: "THEME" }).getByRole("button", { name: "Dark" }).click();
    await section.getByLabel("TITLE").fill("{film} – {date}");
    await section.locator("label.toggle", { hasText: "Frame number" }).click();
    await waitSaved(page, (s) => s.sheet.page === "a3" && s.sheet.landscape && s.sheet.dpi === 300 && s.sheet.columns === 6
      && s.sheet.theme === "dark" && s.sheet.title === "{film} – {date}" && s.sheet.showFrame);
    await expect(section.locator(".section-summary")).toHaveText("PDF · A3 · 6 col · dark");
  });

  test("barcode section: settings and export", async ({ page }) => {
    const section = page.locator("details.section", { hasText: "BARCODE" });
    await section.locator("summary").click();
    await section.getByRole("group", { name: "STYLE" }).getByRole("button", { name: "One color per slice" }).click();
    await waitSaved(page, (s) => s.barcode.mode === "average");
    await section.getByRole("button", { name: "Export barcode" }).click();
    await expectToast(page, "atelier_barcode.jpg saved");
  });
});

test("OUTPUT without analysis: the barcode export is disabled", async ({ page }) => {
  await boot(page, { analysis: false });
  await page.getByRole("tab", { name: "OUTPUT" }).click();
  await page.locator("details.section", { hasText: "BARCODE" }).locator("summary").click();
  await expect(page.getByRole("button", { name: "Export barcode" })).toBeDisabled();
});

test("GALLERY: palette files, A/B reference, go back to a capture, show in folder", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.keyboard.press("End");
  // La capture prend l'image affichée : on attend qu'elle le soit (la vidéo peut finir de charger).
  await expect(page.locator(".tc-big")).toHaveText("01:00:09:23");
  await page.keyboard.press("c");
  await page.getByRole("tab", { name: /GALLERY/ }).click();
  await expect(page.locator(".thumb")).toHaveCount(1);
  await page.getByRole("button", { name: "Save this frame's palette" }).click();
  await expectToast(page, "Palette saved: ase, css, gpl, json");
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: /Go back to 01:00:09:23/ }).click();
  await expect(page.locator(".tc-big")).toHaveText("01:00:09:23");
  await page.getByRole("button", { name: "Set as A/B reference" }).click();
  await expect(page.locator(".gallery").getByText(/Reference A:/)).toBeVisible();
  await page.getByRole("button", { name: /Show .* in Explorer|Show .* in Finder/ }).click();
  await expect.poll(async () => (await calls(page, "reveal")).length).toBe(1);
  expect((await savedSettings(page)).ui.skin).toBe("studio");
});
