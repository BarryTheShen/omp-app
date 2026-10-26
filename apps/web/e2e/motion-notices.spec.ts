import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Motion (#1173, part 5, #1209): a notice fades in when it arrives live, fades out when it is dismissed, and does not
 * fade in again when a reload brings it back. A fake extension raises one warning as a chat starts, as omp's own
 * notices do; the page records each opacity transition on the notice.
 */

const DISK_WARNING = "Disk is almost full on the build volume";
const EXTENSION_FILE = "motion-notices-1209.ts";
const EXTENSION_SOURCE = `export default function motionNotices(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(DISK_WARNING)}, "warning");
  });
}
`;

const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-1209-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec "$@" --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  chatWrapper: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

declare global {
  interface Window {
    __fades?: string[];
  }
}

/** Runs in the page before any script: records each opacity transition that starts on a notice. */
function recordFades(): void {
  const fades: string[] = [];
  window.__fades = fades;
  document.addEventListener("transitionrun", (event) => {
    if (event.propertyName !== "opacity") return;
    const target = event.target;
    if (!(target instanceof Element) || !target.matches("article[data-notice-key]")) return;
    fades.push(target.classList.contains("opacity-0") ? "notice:leave" : "notice:enter");
  });
}

async function fadeCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const entry of window.__fades ?? []) counts[entry] = (counts[entry] ?? 0) + 1;
    return counts;
  });
}

/** Turns the theme on or off the way the Settings toggle does: the root's `dark` class, then the page settles. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "a warning fades in once when it arrives live, does not fade in again on reload, and fades out when dismissed",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordFades) });
    // The stack has drawn for longer than its settle window before the chat starts, so the warning that the chat's
    // start raises is live, as it is in omp's own start.
    await page.waitForTimeout(2_500);
    await startChat(page);
    const warning = page.locator("article[data-notice-key]", { hasText: DISK_WARNING });
    await expect(warning).toBeVisible({ timeout: 60_000 });
    const key = await warning.getAttribute("data-notice-key");
    expect(key, "the warning has a key").not.toBeNull();
    await waitForFiniteAnimations(page);
    expect(await fadeCounts(page), "the live warning fades in once").toEqual({
      "notice:enter": 1,
    });
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-notices-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "motion-notices-dark.png") });
    await setTheme(page, false);

    await page.reload();
    await expect(warning).toBeVisible({ timeout: 60_000 });
    expect(
      await warning.getAttribute("data-notice-key"),
      "a reload draws the warning under the same key",
    ).toBe(key);
    await waitForFiniteAnimations(page);
    expect(await fadeCounts(page), "a warning that a reload brings back does not fade").toEqual({});

    await warning.locator("[data-notice-dismiss]").click();
    await expect(warning).toHaveCount(0, { timeout: 10_000 });
    expect(await fadeCounts(page), "the dismissed warning fades out once").toEqual({
      "notice:leave": 1,
    });
  },
);
