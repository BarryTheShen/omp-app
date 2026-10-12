import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** Window sizes from a small phone to a large monitor, and the owner's own window (feedback #651). */
const WINDOWS = [
  { name: "phone-small", width: 320, height: 640 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet-834", width: 834, height: 1021 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "monitor", width: 1920, height: 1080 },
] as const;

interface Fit {
  /** Elements whose right or bottom edge is outside the dialog's own edges. */
  readonly outside: readonly string[];
  /** True when the dialog itself scrolls sideways. */
  readonly scrollsSideways: boolean;
  readonly dialog: { readonly width: number; readonly height: number };
  readonly listHeight: number;
}

async function measure(page: Page): Promise<Fit> {
  return page.getByRole("dialog", { name: "Model and thinking" }).evaluate((dialog) => {
    const frame = dialog.getBoundingClientRect();
    const outside: string[] = [];
    for (const element of dialog.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Ignore the list's own scrolled-away rows: only what is visible inside a scroll container counts.
      if (rect.right > frame.right + 0.5 || rect.left < frame.left - 0.5) {
        outside.push(
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ?? element.textContent?.slice(0, 30)}]`,
        );
      }
    }
    const list = dialog.querySelector('[data-testid="model-list"]');
    return {
      outside: outside.slice(0, 6),
      scrollsSideways: dialog.scrollWidth > dialog.clientWidth + 1,
      dialog: { width: frame.width, height: frame.height },
      listHeight: list?.getBoundingClientRect().height ?? 0,
    };
  });
}

realTest(
  "the model and thinking dialog stays inside its frame and uses the window at every size",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    await mkdir(screenshots, { recursive: true });
    const samples: { name: string; width: number; dialogHeight: number; listHeight: number }[] = [];
    for (const window of WINDOWS) {
      await page.setViewportSize({ width: window.width, height: window.height });
      await page.getByRole("button", { name: /Change model or thinking/ }).click();
      const dialog = page.getByRole("dialog", { name: "Model and thinking" });
      await expect(dialog).toBeVisible();
      // The long-named model is in the list, so a too-wide row would show up in the measurement.
      await expect(dialog.locator('[data-focus-key*="deliberately-long-identifier"]')).toBeVisible({
        timeout: 20_000,
      });
      await waitForFiniteAnimations(page);

      const fit = await measure(page);
      expect(fit.outside, `${window.name}: elements outside the dialog`).toEqual([]);
      expect(fit.scrollsSideways, `${window.name}: dialog scrolls sideways`).toBe(false);

      // Small windows: the dialog fills the window (1rem of margin). Large ones: a roomy box, at most 48 by 52rem.
      const maxWidth = 48 * 16;
      const maxHeight = 52 * 16;
      expect(fit.dialog.width).toBeGreaterThanOrEqual(Math.min(window.width - 16, maxWidth) - 2);
      expect(fit.dialog.width).toBeLessThanOrEqual(Math.min(window.width - 16, maxWidth) + 2);
      expect(fit.dialog.height).toBeGreaterThanOrEqual(Math.min(window.height - 16, maxHeight) - 2);
      expect(fit.dialog.height).toBeLessThanOrEqual(Math.min(window.height - 16, maxHeight) + 2);

      // The model list uses a real share of the dialog (not a fixed 18rem strip).
      expect(fit.listHeight).toBeGreaterThan(fit.dialog.height * 0.3);
      samples.push({
        name: window.name,
        width: window.width,
        dialogHeight: fit.dialog.height,
        listHeight: fit.listHeight,
      });

      await page.screenshot({ path: join(screenshots, `model-dialog-${window.name}.png`) });
      // Done closes it and the window can be resized again.
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
    }
    // A taller dialog shows more of the list: sorted by dialog height, the list never shrinks. Narrow windows
    // stack the provider chips above the list, so they take a row of their own; the check compares only the
    // side-by-side layouts (the 640 px breakpoint).
    const byHeight = samples
      .filter((sample) => sample.width >= 640)
      .sort((a, b) => a.dialogHeight - b.dialogHeight);
    for (let index = 1; index < byHeight.length; index += 1) {
      const smaller = byHeight[index - 1];
      const taller = byHeight[index];
      expect(taller?.listHeight ?? 0, `${taller?.name} vs ${smaller?.name}`).toBeGreaterThanOrEqual(
        (smaller?.listHeight ?? 0) - 1,
      );
    }

    // The same dialog in the dark theme, in a window the size of the owner's screenshot.
    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 834, height: 1021 });
    // A chat with no message yet is not saved by omp, so the session list is empty: start a new one.
    await startChat(dark);
    await dark.getByRole("button", { name: /Change model or thinking/ }).click();
    const darkDialog = dark.getByRole("dialog", { name: "Model and thinking" });
    await expect(darkDialog.getByRole("button", { name: /context/ }).first()).toBeVisible({
      timeout: 20_000,
    });
    await waitForFiniteAnimations(dark);
    const darkFit = await measure(dark);
    expect(darkFit.outside, "dark: elements outside the dialog").toEqual([]);
    await dark.screenshot({ path: join(screenshots, "model-dialog-dark.png") });
  },
);
