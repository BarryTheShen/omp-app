import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";
import {
  isLabelKey,
  markProbe,
  movesIn,
  pressWindows,
  startProbe,
  stopProbe,
} from "./thinking-cycle-probe";

/**
 * Issue #2594: Alt+K (cycle the thinking level) must not move any control of the composer's bottom row except the
 * model button that shows the level. Every animation frame is sampled while the level cycles, at 1280 px and at 390 px,
 * in light and dark. The model button keeps one width, and its text is never cut. While a reply streams, the same holds,
 * and the page does not overflow sideways.
 */

/** Alt+K presses per viewport: more than the levels a model offers, so every level is reached and the cycle wraps. */
const CYCLE_PRESSES = 7;

const DESKTOP = { name: "desktop", width: 1280, height: 900 };
const PHONE = { name: "phone", width: 390, height: 844 };

for (const theme of ["light", "dark"] as const) {
  realTest(
    `${theme}: Alt+K cycles the thinking level at 1280 px and at 390 px without moving the composer's bottom row`,
    async ({ realApp }) => {
      test.slow();
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (value: string) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          ),
      });
      await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
      await mkdir(join(screenshots, "fix-2594"), { recursive: true });
      const composer = await startChat(page);
      await expect(composer).toBeEditable({ timeout: 60_000 });
      const label = page.getByRole("button", { name: /Change model or thinking/ });
      await expect(label).toBeVisible({ timeout: 60_000 });
      await waitForFiniteAnimations(page);

      await startProbe(page, "composer");
      const fits: boolean[] = [];
      for (const viewport of [DESKTOP, PHONE]) {
        await markProbe(page, "resize", 0, viewport.name);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await waitForFiniteAnimations(page);
        for (let press = 1; press <= CYCLE_PRESSES; press += 1) {
          await markProbe(page, "press", press, viewport.name);
          await page.keyboard.press("Alt+k");
          await page.waitForTimeout(1_500);
          fits.push(await label.evaluate((button) => button.scrollWidth <= button.clientWidth + 1));
          // The composer itself: in a new chat it sits mid-screen, above any fixed strip at the bottom.
          await page.locator('[data-shell-region="composer"]').screenshot({
            path: join(screenshots, "fix-2594", `${theme}-${viewport.name}-press-${press}.png`),
          });
        }
      }

      const windows = pressWindows(await stopProbe(page));
      expect(windows).toHaveLength(2 * CYCLE_PRESSES);
      // The probe must have seen the composer's model button: an empty sample would pass every check below.
      expect(
        Object.keys(windows[0]?.baseline.boxes ?? {}).filter((key) =>
          key.includes("surface:model"),
        ),
        "the probe found the composer's model button",
      ).toHaveLength(1);
      const moves = windows.flatMap(({ mark, baseline, frames }) =>
        movesIn(baseline, frames).map((move) => ({
          viewport: mark.viewport,
          press: mark.index,
          ...move,
        })),
      );
      expect(
        moves.filter((move) => !isLabelKey(move.key)),
        "composer boxes other than the model moved while the level cycled",
      ).toEqual([]);
      expect(
        moves.filter((move) => isLabelKey(move.key)),
        "the model button changed its box while the level cycled",
      ).toEqual([]);
      expect(fits, "the model button's text was cut at some press").not.toContain(false);
      expect(realApp.problems).toEqual([]);
    },
  );
}

/** Alt+K presses while a reply streams. The editor shows the steer placeholder, and the toolbar keeps its labels. */
const RUN_PRESSES = 3;

for (const theme of ["light", "dark"] as const) {
  realTest(
    `${theme}: Alt+K while a reply streams moves nothing but the label, and the page does not overflow sideways`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (value: string) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          ),
      });
      await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
      await mkdir(join(screenshots, "fix-2594"), { recursive: true });
      const composer = await startChat(page);
      await expect(composer).toBeEditable({ timeout: 60_000 });
      const label = page.getByRole("button", { name: /Change model or thinking/ });
      await expect(label).toBeVisible({ timeout: 60_000 });
      const stop = page.getByRole("button", { name: "Stop generating" });
      await sendPrompt(composer, "stream_long_code show the long block");
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await waitForFiniteAnimations(page);
      // The steer hint is the editor's placeholder while a reply streams; Execution modes keeps its label beside the model.
      await expect(composer).toHaveAttribute("placeholder", "Enter steers · Ctrl+Enter queues");
      await expect(
        page
          .getByRole("button", { name: "Execution modes", exact: true })
          .getByText("Execution modes", { exact: true }),
      ).toBeVisible();

      await startProbe(page, "composer");
      const fits: boolean[] = [];
      const contained: boolean[] = [];
      for (let press = 1; press <= RUN_PRESSES; press += 1) {
        await markProbe(page, "press", press, "running");
        await page.keyboard.press("Alt+k");
        await page.waitForTimeout(1_000);
        // Closes this press's window, so the checks and the screenshot below are not part of its frames.
        await markProbe(page, "resize", 0, "settled");
        // The presses must land while the reply streams, or the checks below say nothing about it.
        await expect(stop).toBeVisible();
        fits.push(await label.evaluate((button) => button.scrollWidth <= button.clientWidth + 1));
        contained.push(
          await page.evaluate(() => {
            const root = document.documentElement;
            const toolbar = document.querySelector('[data-layout-area="composerToolbar"]');
            return (
              root.scrollWidth <= root.clientWidth &&
              (toolbar === null || toolbar.scrollWidth <= toolbar.clientWidth + 1)
            );
          }),
        );
        await page.locator('[data-shell-region="composer"]').screenshot({
          path: join(screenshots, "fix-2594", `${theme}-running-press-${press}.png`),
        });
      }
      // The same running composer at a phone's width, for the screenshots.
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
      await expect(stop).toBeVisible();
      await page.locator('[data-shell-region="composer"]').screenshot({
        path: join(screenshots, "fix-2594", `${theme}-running-phone.png`),
      });

      const windows = pressWindows(await stopProbe(page));
      expect(windows).toHaveLength(RUN_PRESSES);
      expect(
        Object.keys(windows[0]?.baseline.boxes ?? {}).filter((key) =>
          key.includes("surface:model"),
        ),
        "the probe found the composer's model button",
      ).toHaveLength(1);
      const moves = windows.flatMap(({ mark, baseline, frames }) =>
        movesIn(baseline, frames).map((move) => ({
          viewport: mark.viewport,
          press: mark.index,
          ...move,
        })),
      );
      expect(
        moves.filter((move) => !isLabelKey(move.key)),
        "composer boxes other than the model moved while a reply streamed",
      ).toEqual([]);
      expect(
        moves.filter((move) => isLabelKey(move.key)),
        "the model button changed its box while a reply streamed",
      ).toEqual([]);
      expect(fits, "the model button's text was cut while a reply streamed").not.toContain(false);
      expect(
        contained,
        "the page or the composer toolbar overflowed sideways while a reply streamed",
      ).not.toContain(false);
      expect(realApp.problems).toEqual([]);
    },
  );
}
