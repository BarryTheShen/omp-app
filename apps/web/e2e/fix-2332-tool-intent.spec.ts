/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  REAL_OMP,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #2332 on real omp: a bash call's intent (the model's `i` argument, which omp 18.12.2 and newer sends with the call)
 * shows on the card's summary line while the call runs, in place of its command. When the call ends, the summary goes
 * back to the command on the same line, so the card keeps its height. The fake model asks for the call with the keyword
 * `intent_probe` and a number of seconds. The harness default omp can be older than 18.12.2: then this skips, because
 * that omp sends no intent.
 */

const INTENT = "Waiting for the fixture command to finish";
const COMMAND = "sleep 9; echo intent-probe-done";
const NEEDS_OMP = "needs omp 18.12.2 or newer";

/** Whether this omp sends a tool call's intent, judged by its version: omp 18.12.2 is the first to send it. */
function ompSendsToolIntent(omp: string): boolean {
  const result = spawnSync(omp, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const printed = `${result.stdout}${result.stderr}`;
  const match = /omp\/(\d+)\.(\d+)\.(\d+)/.exec(printed);
  if (match === null) throw new Error(`omp --version printed no version: ${printed}`);
  const [major = 0, minor = 0, patch = 0] = [match[1], match[2], match[3]].map((part) =>
    Number(part),
  );
  return major > 18 || (major === 18 && (minor > 12 || (minor === 12 && patch >= 2)));
}

// The summary is drawn with the muted token: a probe with that colour must match its computed colour before anything
// is captured, so a screenshot cannot show browser defaults.
async function expectTokenColor(summary: Locator): Promise<void> {
  const colors = await summary.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--muted-foreground)";
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(element).color, token };
  });
  expect(colors.token).not.toBe("rgb(0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
}

async function heightOf(card: Locator): Promise<number> {
  const box = await card.boundingBox();
  if (box === null) throw new Error("The tool card has no box on the page.");
  return box.height;
}

// Scrolls the card into view, waits for the animations to finish, then captures the page.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest.setTimeout(240_000);

realTest(
  "real omp: a bash call shows its intent on its card while it runs, in light, dark and 390 px, and the card keeps its height when it ends",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!ompSendsToolIntent(ompBinary ?? REAL_OMP), NEEDS_OMP);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "intent_probe 9");

    const card = page.getByTestId("u3-bash-card").first();
    const summary = card.getByText(INTENT, { exact: true });
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(COMMAND, { exact: true })).toHaveCount(0);
    await expectTokenColor(summary);
    const runningHeight = await heightOf(card);
    await capture(page, "fix-2332-running-light.png", card);

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectTokenColor(summary);
    await capture(page, "fix-2332-running-dark.png", card);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await narrowTo(page);
    await expect(summary).toBeVisible();
    await expectTokenColor(summary);
    await capture(page, "fix-2332-running-390.png", card);

    // The call ends after its sleep, and omp's reply comes in: the summary goes back to the command, at the same height.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(summary).toHaveCount(0, { timeout: 120_000 });
    await expect(card.getByText(COMMAND, { exact: true })).toBeVisible();
    const finishedHeight = await heightOf(card);
    expect(Math.abs(finishedHeight - runningHeight)).toBeLessThan(1);
    expect(realApp.problems).toEqual([]);
  },
);
