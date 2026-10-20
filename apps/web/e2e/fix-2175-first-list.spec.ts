import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { type HeldCatalog, holdCatalog, newHeldCatalog } from "./hold-catalog";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2175: the first `/` in a chat showed an empty popover until omp's command list arrived (1.1 to 1.8 s on the test machine,
 * once 5.4 s). The popover now says "Loading commands…" as soon as it opens, and the rows replace that line when omp
 * answers. omp's answer is held until the test has seen the line, so nothing here waits on a clock: the line shows while
 * omp has not answered, with no row and no "No matching commands.", and the rows replace the line after the release.
 * The page's own timings are written to .data/screenshots as data, not asserted. Captures: light, dark and 390 px.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

const LOADING = "Loading commands…";
const NO_MATCH = "No matching commands.";
const WAIT_MS = 15_000;

/** What the page keeps from before the first key. The times are Date.now() values, written out as data. */
interface ListWatch {
  keyAt: number | null;
  loadingAt: number | null;
  optionAt: number | null;
  /** How often "No matching commands." showed before any row did. The list never says it before omp answers. */
  noMatchBeforeOptions: number;
}

/** The slash list above the composer (`trigger-slot.tsx`). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** Keeps a record in the page, from before the first key: when the key went down, when the loading line and the first
 *  row showed, and how often "No matching commands." showed before any row. */
async function watchList(page: Page): Promise<void> {
  await page.evaluate(
    ({ loading, noMatch }) => {
      const watch: ListWatch = {
        keyAt: null,
        loadingAt: null,
        optionAt: null,
        noMatchBeforeOptions: 0,
      };
      Object.assign(window, { __listWatch: watch });
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "/" && watch.keyAt === null) watch.keyAt = Date.now();
        },
        true,
      );
      const check = () => {
        const list = document.querySelector('[aria-label="Slash commands"]');
        if (list === null) return;
        if (watch.optionAt === null && list.querySelector('[role="option"]') !== null) {
          watch.optionAt = Date.now();
        }
        const line = list.querySelector('[role="status"]');
        if (watch.loadingAt === null && line?.textContent === loading) {
          watch.loadingAt = Date.now();
        }
        if (watch.optionAt === null && (list.textContent ?? "").includes(noMatch)) {
          watch.noMatchBeforeOptions += 1;
        }
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },
    { loading: LOADING, noMatch: NO_MATCH },
  );
}

/** Copies the record out of the page. */
async function readWatch(page: Page): Promise<ListWatch> {
  return page.evaluate(() =>
    Object.assign({}, (window as Window & { __listWatch?: ListWatch }).__listWatch),
  );
}

/**
 * The line and its box take their colours from the design tokens, so a capture cannot show browser defaults: the box's
 * background is the popover token and the line's text is the muted token.
 */
async function expectStyledList(page: Page): Promise<void> {
  const tokens = await page.evaluate(() => {
    const token = (className: string, property: "color" | "backgroundColor") => {
      const probe = document.createElement("div");
      probe.className = className;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const list = document.querySelector('[aria-label="Slash commands"]');
    const line = list?.querySelector('[role="status"]');
    const box = list?.querySelector("div.bg-popover");
    return {
      boxBackground: box ? getComputedStyle(box).backgroundColor : "",
      boxToken: token("bg-popover", "backgroundColor"),
      lineColor: line ? getComputedStyle(line).color : "",
      lineToken: token("text-muted-foreground", "color"),
    };
  });
  expect(tokens.boxToken).not.toBe("rgba(0, 0, 0, 0)");
  expect(tokens.boxBackground).toBe(tokens.boxToken);
  expect(tokens.lineToken).not.toBe("rgba(0, 0, 0, 0)");
  expect(tokens.lineColor).toBe(tokens.lineToken);
}

/**
 * Types `/` into a new chat while omp's answer is held. The line must show while the answer is still held, with no row
 * and no "No matching commands."; it is captured, then the answer is released and the rows replace the line.
 */
async function firstSlashWhileHeld(
  page: Page,
  composer: Locator,
  hold: HeldCatalog,
  variant: "light" | "dark" | "narrow",
  repeat: number,
): Promise<void> {
  await watchList(page);
  await composer.pressSequentially("/");
  await expect(commandList(page).getByRole("status")).toHaveText(LOADING, { timeout: WAIT_MS });
  await expect(commandList(page).getByRole("option")).toHaveCount(0);
  await expectStyledList(page);
  if (variant === "narrow") {
    const box = await commandList(page).locator("div.bg-popover").first().boundingBox();
    expect(box?.x ?? Number.NaN).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? Number.NaN) + (box?.width ?? Number.NaN)).toBeLessThanOrEqual(390);
  }
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `fix-2175-s2-${variant}.png`), fullPage: true });

  // The answer is released only now, after the line has been seen and captured.
  const releasedAt = Date.now();
  hold.release();
  await expect(commandList(page).getByRole("option", { name: /^\/usage/ })).toBeVisible({
    timeout: WAIT_MS,
  });
  await expect(commandList(page).getByRole("status")).toHaveCount(0);
  const watch = await readWatch(page);
  expect(watch.noMatchBeforeOptions).toBe(0);
  await writeFile(
    join(screenshots, `fix-2175-s2-timing-${variant}-${repeat}.json`),
    JSON.stringify(
      {
        lineMs: (watch.loadingAt ?? Number.NaN) - (watch.keyAt ?? Number.NaN),
        rowsMs: (watch.optionAt ?? Number.NaN) - releasedAt,
        noMatchBeforeOptions: watch.noMatchBeforeOptions,
      },
      null,
      2,
    ),
  );
}

realTest(
  "the first `/` shows a loading line while omp has not answered, and the rows replace it (light)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const hold = newHeldCatalog();
    const page = await realApp.open({ beforeLoad: (target) => holdCatalog(target, hold) });
    const composer = await startChat(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await firstSlashWhileHeld(page, composer, hold, "light", testInfo.repeatEachIndex);
  },
);

realTest(
  "the loading line reads in dark mode, and the rows replace it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const hold = newHeldCatalog();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdCatalog(target, hold);
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    const composer = await startChat(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await firstSlashWhileHeld(page, composer, hold, "dark", testInfo.repeatEachIndex);
  },
);

realTest(
  "the loading line stays inside a 390 px screen, and the rows replace it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const hold = newHeldCatalog();
    const page = await realApp.open({ beforeLoad: (target) => holdCatalog(target, hold) });
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await firstSlashWhileHeld(page, composer, hold, "narrow", testInfo.repeatEachIndex);
  },
);
