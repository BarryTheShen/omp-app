import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Motion for the "N notices from omp" line (issue 1736, row 7 of the motion audit, #1173). The line used to appear,
 * expand, collapse and clear in one frame. Now it fades in when its first notice arrives, its list opens and closes over
 * the motion tokens, and it fades out when the notices are dismissed. Three informational notices come from a fake
 * extension whose `session_start` sends them, as the start-up notices spec does. Each test records the line every frame.
 */

const NOTION_MOUNT = "xd://: mounted mcp__notion_fetch, mcp__notion_search";
const CALENDAR_MOUNT = "xd://: mounted mcp__google_calendar_list_events";
const CACHE_NOTICE = "Build cache warmed";
const LINE_TOGGLE = "3 notices from omp";
const EXTENSION_FILE = "motion-7-quiet-1736.ts";
const EXTENSION_SOURCE = `export default function quietNotices(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(NOTION_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CALENDAR_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CACHE_NOTICE)}, "info");
  });
}
`;

// omp does not load a file seeded in the agent's extensions folder here, but it loads any file named with `--extension`.
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-1736-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec '${REAL_OMP}' --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}" "$@"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  ompBinary: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});
realTest.setTimeout(300_000);

/** The line's state in one frame: whether it is hidden, its opacity, and the height of its list. */
interface QuietSample {
  readonly hidden: boolean;
  readonly opacity: number;
  readonly listHeight: number;
}

/** Runs before the app loads. Keeps one sample per frame in which the line changed, and the layout shift no input caused. */
function recordQuiet(): void {
  const samples: QuietSample[] = [];
  Reflect.set(window, "__quietLine", samples);
  const shift = { total: 0 };
  Reflect.set(window, "__quietShift", shift);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (Reflect.get(entry, "hadRecentInput") !== true)
        shift.total += Number(Reflect.get(entry, "value"));
    }
  }).observe({ type: "layout-shift", buffered: true });
  let last = "";
  const sample = (): void => {
    const section = document.querySelector<HTMLElement>('[data-testid="n1-quiet"]');
    // The list's height as drawn: its clip (the grid transition animates that) when it has one, else the list itself.
    const listEl = section?.querySelector<HTMLElement>("ul") ?? null;
    const clip = listEl?.parentElement ?? null;
    const list = listEl === null ? null : clip === section ? listEl : clip;
    const next: QuietSample = {
      hidden: section === null || Boolean(section.hidden),
      opacity: section === null ? 0 : Number(getComputedStyle(section).opacity),
      listHeight: list === null ? 0 : Math.round(list.getBoundingClientRect().height),
    };
    const key = `${next.hidden}|${next.opacity}|${next.listHeight}`;
    if (key !== last) {
      last = key;
      samples.push(next);
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

/** Expands the line once the chat has settled (history loaded, model and context shown), so every capture shows one state. */
async function expandLine(page: Page) {
  await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Fake Model/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Context 5%/).first()).toBeVisible({ timeout: 60_000 });
  const toggle = page.getByRole("button", { name: LINE_TOGGLE });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await waitForFiniteAnimations(page);
  return toggle;
}

realTest.describe("the notices line moves over its tokens", () => {
  realTest(
    "the line fades in, its list opens and closes, and it fades out when dismissed",
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.emulateMedia({ reducedMotion: "no-preference" });
          await target.addInitScript(recordQuiet);
        },
      });
      await startChat(page);
      const toggle = await expandLine(page);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await waitForFiniteAnimations(page);
      await page.getByRole("button", { name: "Dismiss notices from omp" }).click();
      await expect(page.getByTestId("n1-quiet")).toBeHidden();
      // The recorder samples once per frame, so wait for two frames before reading the last change it made.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const samples = await page.evaluate<QuietSample[]>(() => Reflect.get(window, "__quietLine"));
      const fading = samples.filter((sample) => sample.opacity > 0.05 && sample.opacity < 0.95);
      const listHeights = samples.map((sample) => sample.listHeight);
      const tallest = Math.max(...listHeights);
      const between = listHeights.filter((height) => height > 2 && height < tallest - 2);
      expect(
        fading.length,
        "frames in which the line is part-way through its fade",
      ).toBeGreaterThanOrEqual(3);
      expect(
        between.length,
        "frames in which the list is part-way open or closed",
      ).toBeGreaterThanOrEqual(2);
      expect(samples.at(-1)?.hidden, "the line is hidden once its fade ends").toBe(true);
      const shift = await page.evaluate<number>(() =>
        Reflect.get(Reflect.get(window, "__quietShift"), "total"),
      );
      expect(
        shift,
        "layout shift no input caused, while the line appears, expands and leaves",
      ).toBeLessThan(0.02);
    },
  );

  realTest("the expanded line, captured in light", async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "no-preference" });
      },
    });
    await startChat(page);
    await expandLine(page);
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-7-quiet-light.png") });
  });

  realTest("the expanded line, captured in dark", async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "no-preference" });
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    await startChat(page);
    await expandLine(page);
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-7-quiet-dark.png") });
  });

  realTest("the expanded line at 390 px, captured narrow", async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "no-preference" });
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await startChat(page);
    const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
    if ((await drawerClose.count()) > 0) await drawerClose.click();
    await expandLine(page);
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-7-quiet-narrow.png") });
  });
});

realTest.describe("with reduced motion", () => {
  realTest(
    "nothing fades or opens over frames: the line and its list change in one frame",
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.emulateMedia({ reducedMotion: "reduce" });
          await target.addInitScript(recordQuiet);
        },
      });
      await startChat(page);
      const toggle = await expandLine(page);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await page.getByRole("button", { name: "Dismiss notices from omp" }).click();
      await expect(page.getByTestId("n1-quiet")).toBeHidden();
      // The recorder samples once per frame, so wait for two frames before reading the last change it made.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const samples = await page.evaluate<QuietSample[]>(() => Reflect.get(window, "__quietLine"));
      const fading = samples.filter((sample) => sample.opacity > 0.05 && sample.opacity < 0.95);
      const listHeights = samples.map((sample) => sample.listHeight);
      const tallest = Math.max(...listHeights);
      const between = listHeights.filter((height) => height > 2 && height < tallest - 2);
      expect(fading.length, "frames in which the line is part-way through a fade").toBe(0);
      expect(between.length, "frames in which the list is part-way open").toBe(0);
    },
  );
});
