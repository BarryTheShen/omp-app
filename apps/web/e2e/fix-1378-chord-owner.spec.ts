import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1378 on real omp. "Open external editor" works in the message box, and so does "Open command palette"
 * (Ctrl+K). The shortcut sheet let the external editor take Ctrl+K anyway, so only one of the two could ever run,
 * and the sheet said nothing. It now refuses the chord in one sentence that names the shortcut already using it,
 * and the external editor keeps Ctrl+G.
 */

const REFUSAL = "Ctrl+K is already used by “Open command palette”.";

realTest(
  "a chord the command palette already runs in the message box is refused, and the external editor keeps Ctrl+G",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    // The sheet opens from Mod+/ only when no text box has focus: move focus off the message box first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Ctrl+G" }).click();
    const field = sheet.getByRole("textbox", { name: "Rebind Open external editor" });
    await expect(field).toHaveValue("Ctrl+G");
    await field.fill("Ctrl+K");
    await field.press("Enter");
    await expect(sheet.getByRole("alert")).toHaveText(REFUSAL);
    await expect(sheet.getByRole("button", { name: "Ctrl+G" })).toBeVisible();

    await waitForFiniteAnimations(page);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({ path: join(screenshots, "fix-1378-refused-light.png") });

    const light = await page
      .locator("body")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect
      .poll(() =>
        page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(light);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1378-refused-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(sheet.getByRole("alert")).toHaveText(REFUSAL);
    await page.screenshot({ path: join(screenshots, "fix-1378-refused-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
