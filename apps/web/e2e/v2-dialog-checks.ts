import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/** Where an open dialog sits once its opening animation is over, and whether anything still moves it. */
async function settled(dialog: Locator): Promise<{
  readonly transform: string;
  readonly translate: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}> {
  return dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      transform: style.transform,
      translate: style.translate,
      left: box.left,
      right: innerWidth - box.right,
      top: box.top,
      bottom: innerHeight - box.bottom,
    };
  });
}

/**
 * The app's dialogs are centred without a transform (2026-11-26): a -50% shift of an odd width or height put the
 * dialog on half a pixel, and the browser drew it, text too, blurred (the wide question card in the desktop window).
 */
export function defineDialogChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(`dialogs are drawn sharp, in ${engine}`, () => {
    realTest.setTimeout(180_000);
    realTest(
      `a dialog is centred with nothing shifting it, and the palette stays near the top, in ${engine}`,
      async ({ realApp, browser }) => {
        // An odd window, as the desktop window often is: half of it is not a whole pixel.
        const context = await browser.newContext({ viewport: { width: 1243, height: 747 } });
        const page = await realApp.open({ path: "/", context });
        await startNewChat(page);
        mkdirSync(screenshots, { recursive: true });

        await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
        const keys = page.getByRole("dialog", { name: "Keys" });
        await expect(keys).toBeVisible();
        const at = await settled(keys);
        expect(at.transform).toBe("none");
        expect(at.translate).toBe("none");
        expect(Math.abs(at.left - at.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(at.top - at.bottom)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: join(screenshots, `dialog-keys-${engine}.png`) });
        await page.keyboard.press("Escape");
        await expect(keys).toHaveCount(0);

        await page.keyboard.press("Control+k");
        const palette = page.getByRole("dialog", { name: "Palette" });
        await expect(palette).toBeVisible();
        const paletteAt = await settled(palette);
        expect(paletteAt.translate).toBe("none");
        expect(Math.abs(paletteAt.left - paletteAt.right)).toBeLessThanOrEqual(1);
        // A quarter of the way down, as before, not centred in the space below.
        expect(Math.abs(paletteAt.top - 747 / 4)).toBeLessThanOrEqual(2);
        await page.screenshot({ path: join(screenshots, `dialog-palette-${engine}.png`) });
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );
  });
}
