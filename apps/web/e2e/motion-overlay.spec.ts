import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Motion (#1173, part 3, #1207): the command palette fades and scales in and out over the motion duration, and
 * stays mounted for its exit. The page records, in every frame, whether the palette is in the document and the
 * opacity of its popup. With the default motion preference the popup's opacity changes over several frames on open,
 * the palette is still mounted for several frames after Escape, and the popup animates over the token duration
 * (--duration-base, 180 ms). With prefers-reduced-motion: reduce it appears and vanishes at once.
 */

declare global {
  interface Window {
    __overlay?: OverlaySample[];
  }
}

interface OverlaySample {
  readonly at: number;
  readonly present: boolean;
  readonly opacity: number;
}

interface FrameCount {
  /** Frames in which the palette was in the document. */
  readonly mounted: number;
  /** Distinct opacities the palette showed in those frames. */
  readonly opacities: number;
}

const PALETTE = '[role="dialog"][aria-label="Command palette"]';

/** Runs in the page before any script: records the palette's presence and opacity in each frame that changes. */
function recordOverlay(): void {
  const samples: OverlaySample[] = [];
  window.__overlay = samples;
  let last = "";
  const tick = (): void => {
    const popup = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Command palette"]',
    );
    const present = popup !== null;
    const opacity = popup ? Math.round(Number(getComputedStyle(popup).opacity) * 1000) / 1000 : -1;
    const key = `${present}/${opacity}`;
    if (key !== last) {
      last = key;
      samples.push({ at: performance.now(), present, opacity });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Frames recorded since `from` (page time): how many show the palette mounted, and how many opacities it showed. */
async function framesSince(page: Page, from: number): Promise<FrameCount> {
  return page.evaluate((start): FrameCount => {
    const mounted = (window.__overlay ?? []).filter(
      (sample) => sample.at >= start && sample.present,
    );
    return {
      mounted: mounted.length,
      opacities: new Set(mounted.map((sample) => sample.opacity)).size,
    };
  }, from);
}

realTest("the command palette fades and scales in and out", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordOverlay) });
  const composer = await startChat(page);
  await composer.focus();

  const openAt = await page.evaluate(() => performance.now());
  await page.keyboard.press("Control+k");
  await expect(page.locator(PALETTE)).toBeVisible();
  await waitForFiniteAnimations(page);
  const opening = await framesSince(page, openAt);
  const declared = await page
    .locator(PALETTE)
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(declared, "the popup animates over --duration-base").toBe("0.18s");
  expect(opening.opacities, "distinct opacities while the palette opens").toBeGreaterThanOrEqual(3);

  const closeAt = await page.evaluate(() => performance.now());
  await page.keyboard.press("Escape");
  await expect(page.locator(PALETTE)).toHaveCount(0);
  const closing = await framesSince(page, closeAt);
  expect(closing.mounted, "frames the palette stays mounted while it exits").toBeGreaterThanOrEqual(
    4,
  );
  console.log(
    `palette: open shows ${opening.opacities} opacities over ${opening.mounted} frames; close stays mounted ${closing.mounted} frames`,
  );
});

realTest.describe("with reduced motion", () => {
  realTest("the command palette appears and vanishes at once", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "reduce" });
        await target.addInitScript(recordOverlay);
      },
    });
    const composer = await startChat(page);
    await composer.focus();
    const openAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("Control+k");
    await expect(page.locator(PALETTE)).toBeVisible();
    await waitForFiniteAnimations(page);
    const opening = await framesSince(page, openAt);
    expect(opening.opacities, "distinct opacities while the palette opens").toBeLessThanOrEqual(2);
    const closeAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("Escape");
    await expect(page.locator(PALETTE)).toHaveCount(0);
    const closing = await framesSince(page, closeAt);
    expect(closing.mounted, "frames the palette stays mounted while it exits").toBeLessThanOrEqual(
      2,
    );
  });
});

for (const variant of ["light", "dark", "narrow"] as const) {
  realTest(
    `command palette open, ${variant}: capture for the pull request`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          if (variant === "dark")
            await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        },
      });
      if (variant === "narrow") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('button[aria-label="Show sessions sidebar"]').click();
      }
      const composer = await startChat(page);
      if (variant === "narrow") {
        const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
        if ((await drawerClose.count()) > 0) await drawerClose.click();
      }
      await composer.focus();
      await page.keyboard.press("Control+k");
      await expect(page.locator(PALETTE)).toBeVisible();
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `motion-palette-${variant}.png`) });
    },
  );
}
