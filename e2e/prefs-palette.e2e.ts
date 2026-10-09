// Préférences (apparence, analyse, mises à jour, projets, à propos),
// palette de commandes (Ctrl K) et aide des raccourcis (?).

import { boot, calls, savedSettings, waitSaved, expect, test } from "./helpers";

const root = (page: import("@playwright/test").Page) =>
  page.evaluate(() => ({ ...document.documentElement.dataset }) as Record<string, string>);

test.describe("Preferences", () => {
  test("open from the gear and with Ctrl+,; Esc and the close button close it", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.getByRole("button", { name: "Preferences" }).click();
    const dialog = page.getByRole("dialog", { name: "PREFERENCES" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.keyboard.press("Control+,");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close the preferences" }).click();
    await expect(dialog).toBeHidden();
  });

  test("skins apply at once, are saved, survive a reload and never tint the viewer", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("dialog", { name: "PREFERENCES" });
    await dialog.getByRole("radio", { name: /Mission/ }).click();
    expect(await root(page)).toMatchObject({ skin: "mission", theme: "light", effects: "on" });
    await expect(dialog.getByRole("radio", { name: /Mission/ })).toHaveAttribute("aria-checked", "true");
    await waitSaved(page, (s) => s.ui.skin === "mission");
    // Le thème ne s'applique qu'à Studio : grisé, et le bouton du haut disparaît.
    await expect(dialog.getByRole("group", { name: "THEME" }).getByRole("button", { name: "Dark" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Switch to the/ })).toHaveCount(0);
    await dialog.getByRole("radio", { name: /Atomic/ }).click();
    expect(await root(page)).toMatchObject({ skin: "atomic", theme: "dark" });
    await dialog.locator("label.toggle", { hasText: "Skin decoration" }).click();
    expect((await root(page)).effects).toBe("off");
    await waitSaved(page, (s) => s.ui.skin === "atomic" && s.ui.effects === false);
    expect(await page.locator(".viewer-stage").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(21, 21, 21)");
    // Copie locale : appliquée avant même le chargement des réglages au lancement suivant.
    const local = await page.evaluate(() => localStorage.getItem("photogramme.appearance"));
    expect(JSON.parse(local!)).toEqual({ theme: "dark", skin: "atomic", effects: false });
    await dialog.getByRole("radio", { name: /Studio/ }).click();
    await dialog.getByRole("group", { name: "THEME" }).getByRole("button", { name: "Light" }).click();
    expect(await root(page)).toMatchObject({ skin: "studio", theme: "light" });
    await waitSaved(page, (s) => s.ui.skin === "studio" && s.ui.theme === "light");
  });

  test("the theme button in the top bar switches Studio between dark and light", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.getByRole("button", { name: "Switch to the light theme" }).click();
    expect((await root(page)).theme).toBe("light");
    await page.getByRole("button", { name: "Switch to the dark theme" }).click();
    expect((await root(page)).theme).toBe("dark");
    await waitSaved(page, (s) => s.ui.theme === "dark");
  });

  test("the appearance saved locally is applied before the settings load (no flash)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("photogramme.appearance", JSON.stringify({ theme: "light", skin: "mission", effects: true })));
    await page.addInitScript(() => {
      // On fige le chargement des réglages pour voir l'état au premier rendu.
      (window as unknown as { __E2E_OPTS: object }).__E2E_OPTS = { ui: { skin: "mission", theme: "light" } };
    });
    await boot(page, { analysis: true, ui: { skin: "mission", theme: "light" } });
    expect(await root(page)).toMatchObject({ skin: "mission", theme: "light" });
  });

  test("v0.6 kept only the theme locally: it is read once", async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.removeItem("photogramme.appearance");
        localStorage.setItem("photogramme.theme", "light");
        sessionStorage.setItem("seeded", "1");
      }
    });
    await boot(page, { analysis: true, ui: { theme: "light" } });
    expect((await root(page)).theme).toBe("light");
  });

  test("analysis decoder, updates, projects and about", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("dialog", { name: "PREFERENCES" });
    await dialog.getByRole("button", { name: "Analysis" }).click();
    await dialog.getByRole("group", { name: "ANALYSIS DECODER" }).getByRole("button", { name: "CPU" }).click();
    await waitSaved(page, (s) => s.shots.decoder === "cpu");
    await dialog.getByRole("button", { name: "Updates" }).click();
    await dialog.locator("label.toggle", { hasText: "Check for updates at startup" }).click();
    await waitSaved(page, (s) => s.updates.checkAtStartup === true);
    await dialog.getByRole("button", { name: "Check now" }).click();
    await expect(dialog.getByText("Photogramme is up to date.")).toBeVisible();
    await dialog.getByRole("button", { name: "Projects" }).click();
    await expect(dialog.getByText("50.0 MB used")).toBeVisible();
    await dialog.getByRole("button", { name: "Clear saved analyses" }).click();
    await expect(dialog.getByText(/50.0 MB freed/)).toBeVisible();
    await dialog.getByRole("button", { name: "About & licenses" }).click();
    await expect(dialog.getByText(/Photogramme 0.7.0/)).toBeVisible();
    await expect(dialog.getByText(/Instrument Sans, Archivo, Space Mono/)).toBeVisible();
    for (const [name, link] of [["Source code", "repo"], ["Releases", "releases"], ["Report a problem", "issues"], ["Buy me a coffee on Ko-fi", "kofi"]]) {
      await dialog.getByRole("button", { name }).click();
      await expect.poll(async () => (await calls(page, "open_link")).some((c) => c.args.link === link)).toBe(true);
    }
  });

  test("a build without an update key says so", async ({ page }) => {
    await boot(page, { analysis: true, updates: false });
    await page.keyboard.press("Control+,");
    await page.getByRole("dialog", { name: "PREFERENCES" }).getByRole("button", { name: "Updates" }).click();
    await expect(page.getByText(/Automatic updates are not set up in this build/)).toBeVisible();
  });

  test("Esc then an immediate reopen always works (no stale dialog state)", async ({ page }) => {
    await boot(page, { analysis: true });
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Control+,");
      await expect(page.getByRole("dialog", { name: "PREFERENCES" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape"); // Échap répété : le navigateur peut fermer seul, l'état doit suivre
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
  });

  test("shortcuts do nothing while a dialog is open", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("Control+,");
    await page.getByRole("dialog", { name: "PREFERENCES" }).getByRole("button", { name: "Analysis" }).click();
    for (const k of ["c", "p", "s", " ", "ArrowRight"]) await page.keyboard.press(k);
    expect((await calls(page, "write_composed")).length + (await calls(page, "capture")).length).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tc-big")).toHaveText("01:00:00:00");
    await expect(page.locator(".preview-badge")).toHaveCount(0);
  });
});

test.describe("Command palette", () => {
  test("Ctrl+K and the top-bar button open it; search, arrows and Enter run a command", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.getByRole("button", { name: /Search commands/ }).click();
    const dialog = page.getByRole("dialog", { name: "Commands" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.type("skin mis");
    await expect(dialog.getByRole("option").first()).toContainText("Skin: Mission");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    // La commande part après la fermeture (setTimeout) : le skin suit un rendu plus tard.
    await expect.poll(async () => (await root(page)).skin).toBe("mission");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("scopes");
    await expect(dialog.getByRole("option").first()).toContainText("Scopes");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Scopes" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.keyboard.type("go to output");
    await expect(dialog.getByRole("option").first()).toContainText("Output");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "OUTPUT" })).toHaveAttribute("aria-selected", "true");
  });

  test("it leads to a Look layer and loads presets", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("Control+k");
    await page.keyboard.type("palette band");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "LOOK" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("option", { name: /Palette band/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("grading check");
    await expect(page.getByRole("dialog", { name: "Commands" }).getByRole("option").first()).toContainText("Grading check");
    await page.keyboard.press("Enter");
    await waitSaved(page, (s) => s.overlay.name === "Grading check").catch(async (e) => {
      const st = await page.evaluate(() => ({
        input: (document.querySelector(".palette-search input") as HTMLInputElement | null)?.value,
        open: !!document.querySelector("dialog.palette[open]"),
        preset: (document.querySelector(".preset-bar select") as HTMLSelectElement | null)?.value,
      }));
      throw new Error(`${e.message}\nstate: ${JSON.stringify(st)} saved: ${(await savedSettings(page)).overlay?.name}`);
    });
  });

  test("disabled commands are shown but never run; no match says so", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("Control+k");
    await page.keyboard.type("wipe");
    const item = page.getByRole("option", { name: /A\/B wipe/ });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    // Un clic sur une commande grisée (force : Playwright refuse sinon de cliquer un élément désactivé).
    await item.click({ force: true });
    await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("xyzzy");
    await expect(page.getByText(/No command matches/)).toBeVisible();
  });

  test("every enabled command runs without an error", async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await boot(page, { analysis: true });
    // Ouvrent un sélecteur, ferment le film ou lancent un long travail : testées ailleurs.
    const skip = /Open a film|Close this film tab|Cancel the current job|Export .* stills|Make the contact sheet|Analyze|Re-analyze|Import an edit list/;
    const dialog = page.getByRole("dialog", { name: "Commands" });
    const ran: string[] = [];
    const slow: string[] = [];
    // Par position dans la liste complète : un libellé peut changer après exécution (Play → Pause).
    for (let i = 0; ; i++) {
      await page.keyboard.press("Control+k");
      // Sous charge, un rendu peut prendre plus d'une seconde ; une palette bloquée, elle,
      // ne s'ouvre jamais : 5 s départagent les deux.
      const t0 = Date.now();
      const opened = await dialog.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      if (!opened) {
        const focus = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160));
        const open = await page.evaluate(() => Array.from(document.querySelectorAll("dialog[open]")).map((d) => d.className));
        throw new Error(`Ctrl+K did not open after: ${ran.slice(-3).join(" | ")} — focus: ${focus} — open dialogs: ${open.join(",")}`);
      }
      if (Date.now() - t0 > 300) slow.push(`${ran[ran.length - 1]}: ${Date.now() - t0} ms`);
      const options = dialog.getByRole("option");
      const n = await options.count();
      if (i >= n) {
        await page.keyboard.press("Escape");
        break;
      }
      const item = options.nth(i);
      const label = (await item.locator(".palette-label").textContent())!;
      if (skip.test(label) || (await item.getAttribute("aria-disabled")) === "true") {
        await page.keyboard.press("Escape");
        continue;
      }
      await item.scrollIntoViewIfNeeded();
      await item.click();
      ran.push(label);
      await expect(dialog).toBeHidden();
      // Une commande peut ouvrir les préférences, l'aide ou un menu : on referme tout.
      for (let k = 0; k < 3 && (await page.locator("dialog[open]").count()) > 0; k++) await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
    if (slow.length) console.log(`slow reopenings: ${slow.join(" · ")}`);
    expect(ran.length, ran.join(" | ")).toBeGreaterThan(40);
    expect(errors).toEqual([]);
  });

  test("a late close event from a previous closing does not close a reopened window", async ({ page }) => {
    await boot(page, { analysis: true });
    // Le navigateur envoie « close » en différé ; une saisie peut passer avant (Ctrl+K juste
    // après une commande lourde). On rejoue cet événement en retard sur chaque fenêtre ouverte.
    const stale = (name: string) =>
      page.getByRole("dialog", { name }).evaluate((d) => d.dispatchEvent(new Event("close")));
    await page.keyboard.press("Control+k");
    await stale("Commands");
    await page.waitForTimeout(200);
    await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+,");
    await stale("PREFERENCES");
    await page.waitForTimeout(200);
    await expect(page.getByRole("dialog", { name: "PREFERENCES" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await stale("Keyboard shortcuts");
    await page.waitForTimeout(200);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("commands run back to back: Ctrl+K never gets lost and each search starts empty", async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, { analysis: true });
    const dialog = page.getByRole("dialog", { name: "Commands" });
    const queries = ["zoom 200", "zoom 100", "zoom fit", "scopes"];
    // Enchaînement rapide : le champ de la palette fermée gardait le clavier un instant
    // (Ctrl+K pris pour une saisie), et la recherche précédente restait collée à la nouvelle.
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press("Control+k");
      await expect(dialog, `Ctrl+K at round ${i}`).toBeVisible({ timeout: 3000 });
      await page.keyboard.type(queries[i % 4]);
      await expect(dialog.getByRole("combobox")).toHaveValue(queries[i % 4]);
      await dialog.getByRole("option").first().click();
      await expect(dialog).toBeHidden();
    }
  });

  test("? opens the shortcut list", async ({ page }) => {
    await boot(page, { analysis: true });
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Capture the displayed frame")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /all shortcuts/ }).click();
    await expect(dialog).toBeVisible();
  });
});
