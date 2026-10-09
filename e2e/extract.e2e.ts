// Onglet EXTRACT : analyse, liste des plans, liste de montage, modes, exports.
// Et ce qui entoure : onglets de films, projet relu (dont les noms d'onglets de la v0.6).

import type { Page } from "@playwright/test";
import { boot, calls, savedSettings, waitSaved, expectToast, expect, test } from "./helpers";

/** Ouvre les réglages repliables du mode « par plan ». */
async function openSettings(page: Page) {
  const d = page.locator("details.extract-settings");
  if (!(await d.evaluate((el: HTMLDetailsElement) => el.open))) await d.locator("summary").click();
}

test("analyze a film: progress, toast, shot list and barcode appear", async ({ page }) => {
  const errors = await boot(page, { analysis: false });
  await expect(page.getByText("Analyze the film to list its shots")).toBeVisible();
  await expect(page.locator(".statusbar")).toContainText("GPU-decodable file (NVDEC)");
  await page.getByRole("button", { name: "Analyze the film" }).click();
  await expectToast(page, /Analysis done/);
  await expect(page.locator(".shot")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: /Film barcode/ })).toBeVisible();
  await openSettings(page);
  await expect(page.getByText(/shots · NVDEC/)).toBeVisible();
  // La barre d'état dit ce qui a réellement servi, pas seulement ce que le fichier permet.
  await expect(page.locator(".statusbar")).toContainText("Analyzed on the GPU (NVDEC)");
  expect(errors).toEqual([]);
});

test("threshold and minimum length re-list the shots without re-analyzing", async ({ page }) => {
  await boot(page, { analysis: true });
  const before = await page.locator(".shot").count();
  const thr = page.getByRole("textbox", { name: "Threshold" });
  await openSettings(page);
  await thr.fill("40");
  await thr.press("Enter");
  await expect.poll(async () => (await calls(page, "list_shots")).some((c) => c.args.threshold === 40)).toBe(true);
  await expect.poll(() => page.locator(".shot").count()).toBeLessThan(before);
  const min = page.getByRole("textbox", { name: "Minimum shot length" });
  await min.fill("2");
  await min.press("Enter");
  await expect.poll(async () => (await calls(page, "list_shots")).some((c) => c.args.minSeconds === 2)).toBe(true);
  await waitSaved(page, (s) => s.shots.threshold === 40 && s.shots.minSeconds === 2);
  expect((await calls(page, "analyze")).length).toBe(0);
});

test("shot list: select all / none / invert, merge, add a cut, undo edits", async ({ page }) => {
  await boot(page, { analysis: true });
  const total = await page.locator(".shot").count();
  await expect(page.getByText(`${total}/${total} selected`)).toBeVisible();
  await page.getByRole("button", { name: "None", exact: true }).click();
  await expect(page.getByText(`0/${total} selected`)).toBeVisible();
  await expect(page.getByRole("button", { name: /Export/ }).last()).toBeDisabled();
  await page.getByRole("checkbox", { name: "Export shot 2" }).check();
  await expect(page.getByText(`1/${total} selected`)).toBeVisible();
  await page.getByRole("button", { name: "Invert" }).click();
  await expect(page.getByText(`${total - 1}/${total} selected`)).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText(`${total}/${total} selected`)).toBeVisible();
  // Fusion du plan 1 avec le 2.
  await page.getByRole("button", { name: "Merge shot 1 with the next one" }).click();
  await expect(page.locator(".shot")).toHaveCount(total - 1);
  await expect(page.locator(".shot").first().getByText("×2")).toBeVisible();
  // Coupe à la main au milieu d'un plan (B).
  await page.getByRole("button", { name: "Go to shot 3" }).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("b");
  await expect(page.locator(".shot")).toHaveCount(total);
  await expect(page.locator(".shot em", { hasText: "✂" })).toHaveCount(1);
  await expect(page.locator(".cuts.manual")).toHaveCount(1);
  // Une coupe déjà là : message, rien ne change.
  await page.keyboard.press("b");
  await expectToast(page, "There is already a cut here.");
  await page.getByRole("button", { name: "Undo edits" }).click();
  await expect(page.locator(".shot")).toHaveCount(total);
  await expect(page.locator(".shot em")).toHaveCount(0);
});

test("clicking a shot thumbnail seeks to it and follows playback", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("button", { name: "Go to shot 4" }).click();
  const start = await page.locator(".shot").nth(3).locator(".shot-tc span").first().textContent();
  await expect(page.locator(".tc-big")).toHaveText(start!);
  await expect(page.locator(".shot.is-active")).toHaveCount(1);
  await expect(page.locator(".shot").nth(3)).toHaveClass(/is-active/);
});

test("import an edit list, then remove it and go back to detection", async ({ page }) => {
  await boot(page, { analysis: true });
  await openSettings(page);
  await page.getByRole("group", { name: "Cuts from" }).getByRole("button", { name: "Edit list" }).click();
  await expectToast(page, "6 shots imported from atelier_v7.edl");
  await expect(page.locator(".shot")).toHaveCount(6);
  await expect(page.locator(".shot-clip").first()).toHaveText("A001_C001");
  await expect(page.getByRole("textbox", { name: "Threshold" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("textbox", { name: "Threshold" })).toBeVisible();
  expect((await calls(page, "clear_cuts")).length).toBe(1);
});

test("extraction modes: every X s and N frames update the plan and are saved", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("tab", { name: "Every X s" }).click();
  const every = page.getByRole("textbox", { name: "One frame every" });
  await every.fill("1");
  await every.press("Enter");
  await expect(page.getByText("10 frames", { exact: false }).first()).toBeVisible();
  await waitSaved(page, (s) => s.batch.mode === "interval" && s.batch.intervalSeconds === 1);
  await page.getByRole("tab", { name: "N frames" }).click();
  const n = page.getByRole("textbox", { name: "Frames spread over the film" });
  await n.fill("30");
  await n.press("Enter");
  await expect(page.getByRole("button", { name: "Export 30 JPEG stills" })).toBeVisible();
  await waitSaved(page, (s) => s.batch.mode === "spread" && s.batch.spreadCount === 30);
  // Image retenue par plan : N par plan.
  await page.getByRole("tab", { name: "By shot" }).click();
  await openSettings(page);
  await page.getByRole("group", { name: "FRAME KEPT PER SHOT" }).getByRole("button", { name: "N per shot" }).click();
  await expect(page.getByRole("textbox", { name: "Frames per shot" })).toBeVisible();
  await waitSaved(page, (s) => s.shots.pick.mode === "spread");
});

test("export stills with the look: every frame is composed and written, progress then toast", async ({ page }) => {
  await boot(page, { analysis: true });
  // Le nombre d'images arrive avec le plan d'export (calculé côté Rust) : on l'attend.
  await expect(page.locator(".btn-capture")).toHaveText(/\d+/);
  const label = await page.locator(".btn-capture").textContent();
  const planned = Number(/(\d+)/.exec(label!)![1]);
  await page.locator(".btn-capture").click();
  await expectToast(page, `${planned} frames exported`);
  expect((await calls(page, "write_composed")).length).toBe(planned);
  expect((await calls(page, "batch_finish")).length).toBe(1);
  const start = (await calls(page, "batch_start"))[0].args as { target: { kind: string; compose: boolean } };
  expect(start.target).toEqual({ kind: "stills", compose: true });
  await page.getByRole("tab", { name: /GALLERY/ }).click();
  await expect(page.locator(".thumb")).toHaveCount(planned);
  await expect(page.getByRole("tab", { name: /GALLERY/ })).toContainText(String(planned));
});

test("export stills without the look: the Rust writes them, the gallery fills", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("tab", { name: "LOOK" }).click();
  await page.locator("label.toggle", { hasText: "Apply the look to exported stills" }).click();
  await waitSaved(page, (s) => !s.export.overlay);
  await page.getByRole("tab", { name: "EXTRACT" }).click();
  await page.locator(".btn-capture").click();
  await expectToast(page, /frames exported \+ CSV list/);
  expect((await calls(page, "write_composed")).length).toBe(0);
  const start = (await calls(page, "batch_start"))[0].args as { target: { compose: boolean } };
  expect(start.target.compose).toBe(false);
});

test("contact sheet: pages are laid out and sent, toast names the PDF", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("group", { name: "Output" }).getByRole("button", { name: "Contact sheet" }).click();
  await expect(page.getByRole("button", { name: /Make the contact sheet · \d+ page/ })).toBeVisible();
  await page.getByRole("button", { name: /Make the contact sheet/ }).click();
  await expectToast(page, "Contact sheet saved: atelier_contact.pdf");
  expect((await calls(page, "sheet_page")).length).toBeGreaterThan(0);
  const start = (await calls(page, "batch_start"))[0].args as { target: { kind: string; cellWidth: number } };
  expect(start.target.kind).toBe("sheet");
  expect(start.target.cellWidth).toBeGreaterThan(0);
});

test("cancel an export: the job stops and the files already written are kept", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("tab", { name: "LOOK" }).click();
  await page.locator("label.toggle", { hasText: "Apply the look to exported stills" }).click();
  await waitSaved(page, (s) => !s.export.overlay);
  await page.getByRole("tab", { name: "EXTRACT" }).click();
  // Le faux backend écrit lentement : on a le temps d'annuler.
  await page.evaluate(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } };
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (c, a) => {
      if (c === "batch_start") return { job: 99, total: 50, dir: "D:\\x", width: 1280, height: 536 };
      return orig(c, a);
    };
  });
  await page.locator(".btn-capture").click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect((await calls(page, "batch_cancel")).length).toBe(1);
});

test("no output folder: exporting asks for one first", async ({ page }) => {
  await boot(page, { analysis: true, outputDir: null });
  await page.locator(".btn-capture").click();
  await expect.poll(async () => (await calls(page, "pick_output_dir")).length).toBe(1);
  await expectToast(page, /frames exported/);
  expect((await savedSettings(page)).outputDir).toContain("stills");
});

test("v0.6 projects reopen on the renamed tabs (settings → LOOK, captures → GALLERY)", async ({ page }) => {
  await boot(page, { analysis: true, savedTab: "settings" });
  await expect(page.getByRole("tab", { name: "LOOK" })).toHaveAttribute("aria-selected", "true");
  const p2 = await page.context().newPage();
  await boot(p2, { analysis: true, savedTab: "captures" });
  await expect(p2.getByRole("tab", { name: /GALLERY/ })).toHaveAttribute("aria-selected", "true");
  await p2.close();
});

test("the inspector tab is saved with the project", async ({ page }) => {
  await boot(page, { analysis: true });
  await page.getByRole("tab", { name: "OUTPUT" }).click();
  await expect.poll(async () => (await calls(page, "project_save")).some((c) => (c.args.ui as { tab?: string })?.tab === "output")).toBe(true);
});

test("film tabs: switch, close, open with Ctrl+O, drop a film on the window", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  await page.getByRole("tab", { name: /voix_de_lodeve_final/ }).click();
  await expect.poll(async () => (await calls(page, "tab_open")).some((c) => c.args.key === "k2")).toBe(true);
  await expect(page.locator(".viewer-meta")).toBeVisible();
  await page.getByRole("button", { name: /Close voix_de_lodeve_final|Close atelier/ }).first().click();
  await expect.poll(async () => (await calls(page, "tab_close")).length).toBe(1);
  await expect(page.getByText("NO FILM LOADED")).toBeVisible();
  await page.keyboard.press("Control+o");
  await expect.poll(async () => (await calls(page, "pick_video")).length).toBe(1);
  await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible();
  // Film déposé : ouvert côté Rust, l'interface reçoit l'événement « film ».
  await page.evaluate(() => (window as unknown as { __e2e: { dropFilm: () => void } }).__e2e.dropFilm());
  await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the empty state opens a film", async ({ page }) => {
  await boot(page, { film: false });
  await page.getByRole("button", { name: "Open a film" }).first().click();
  await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible();
});

test("a failing command shows an error toast and the app keeps working", async ({ page }) => {
  const errors = await boot(page, { analysis: true, failCommand: "capture" });
  await page.getByRole("tab", { name: "LOOK" }).click();
  await page.locator("label.toggle", { hasText: "Apply the look to exported stills" }).click();
  await waitSaved(page, (s) => !s.export.overlay);
  await page.keyboard.press("c");
  await expect(page.getByRole("alert")).toContainText("capture failed (test).");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".tc-big")).toHaveText("01:00:00:01");
  expect(errors).toEqual([]);
});

test("film warnings are shown and can be hidden", async ({ page }) => {
  await boot(page, { analysis: true, warnings: ["Variable frame rate: captures may be off by one frame."] });
  await expect(page.getByText("Variable frame rate")).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByText("Variable frame rate")).toHaveCount(0);
});

test("shot settings fold away so the shot list comes first, and the choice is remembered", async ({ page }) => {
  await boot(page, { analysis: true });
  const d = page.locator("details.extract-settings");
  // Liste présente : réglages repliés, résumé lisible, liste visible.
  await expect(d).not.toHaveAttribute("open", "");
  await expect(d.locator(".section-summary")).toHaveText(/Detection · 10 · 0.5 s · middle/);
  await expect(page.locator(".shot").first()).toBeVisible();
  await d.locator("summary").click();
  await expect(page.getByRole("textbox", { name: "Threshold" })).toBeVisible();
  await page.reload();
  await expect(page.locator("details.extract-settings")).toHaveAttribute("open", "");
});

test("without a shot list the settings stay open: analyzing is one click away", async ({ page }) => {
  await boot(page);
  await expect(page.locator("details.extract-settings")).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Analyze the film" })).toBeVisible();
});
