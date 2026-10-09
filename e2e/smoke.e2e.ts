// Captures d'écran pour relecture visuelle (pas d'assertion de rendu) : fenêtres dans chaque skin.
import { boot, calls, expect, expectToast, test } from "./helpers";

for (const skin of ["studio", "atomic", "mission"] as const) {
  test(`dialog screenshots: ${skin}`, async ({ page }) => {
    await boot(page, { analysis: true, ui: { skin } });
    await page.keyboard.press("Control+,");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `e2e/.results/screens/dialog-prefs-${skin}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("pal");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `e2e/.results/screens/dialog-palette-${skin}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `e2e/.results/screens/dialog-keys-${skin}.png` });
  });
}

test("an error nobody caught still shows a message, and the interface sends signs of life", async ({ page }) => {
  const errors = await boot(page, { analysis: true });
  await expect.poll(async () => (await calls(page, "heartbeat")).length).toBeGreaterThan(0);
  expect((await calls(page, "heartbeat"))[0].args).toEqual({ visible: true });
  await page.evaluate(() => void Promise.reject(new Error("Boom from nowhere")));
  await expectToast(page, "Boom from nowhere");
  // Erreur provoquée par le test lui-même : la console l'a vue, c'est voulu.
  expect(errors.join("\n")).toContain("Boom from nowhere");
  errors.length = 0;
});
