// Captures d'écran pour relecture visuelle (pas d'assertion de rendu) : fenêtres dans chaque skin.
import { boot, expect, test } from "./helpers";

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
