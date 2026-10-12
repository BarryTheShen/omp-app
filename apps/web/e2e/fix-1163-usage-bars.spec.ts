import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const MINUTE = 60_000;
const NARROW = { width: 390, height: 844 } as const;

/**
 * The shape `omp usage --json` returns (reports with their limits), with each reset set from the time the spec starts.
 * openai-codex reports its "5 hours" window for two accounts; the fullest one's share is the one drawn.
 */
function usageFixture(now: number): unknown {
  const limitWindow = (id: string, label: string, resetMinutes: number) => ({
    id,
    label,
    resetsAt: now + resetMinutes * MINUTE,
  });
  const limit = (id: string, label: string, usedFraction: number, resetMinutes: number) => ({
    id,
    label,
    window: limitWindow(id, label, resetMinutes),
    amount: { usedFraction },
  });
  return {
    generatedAt: now,
    reports: [
      {
        provider: "anthropic",
        fetchedAt: now,
        metadata: {},
        limits: [
          limit("anthropic:5h", "5 Hour", 0.04, 125),
          limit("anthropic:7d", "7 Day", 0.8, 3 * 24 * 60 + 4 * 60),
        ],
      },
      {
        provider: "cursor",
        fetchedAt: now,
        metadata: {},
        limits: [limit("cursor:monthly", "Monthly", 0, 26 * 60)],
      },
      {
        provider: "openai-codex",
        fetchedAt: now,
        metadata: {},
        limits: [limit("openai-codex:5h", "5 hours", 0.95, 3 * 60)],
      },
      {
        provider: "openai-codex",
        fetchedAt: now,
        metadata: {},
        limits: [limit("openai-codex:5h", "5 hours", 0.2, 3 * 60 + 30)],
      },
    ],
  };
}

// A stand-in for omp that only the usage read reaches: `omp usage` prints the fixture, and every other call runs the
// real omp. The app's server finds it first on its PATH; the chat's omp is started by its absolute path.
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-1163-usage-"));
const FIXTURE_FILE = join(FIXTURE_DIRECTORY, "usage.json");
const WRAPPER = join(FIXTURE_DIRECTORY, "omp");
writeFileSync(FIXTURE_FILE, `${JSON.stringify(usageFixture(Date.now()))}\n`);
writeFileSync(
  WRAPPER,
  `#!/bin/sh\nif [ "$1" = "usage" ]; then cat "${FIXTURE_FILE}"; exit 0; fi\nexec "${REAL_OMP}" "$@"\n`,
);
chmodSync(WRAPPER, 0o755);

realTest.use({ serverEnv: { PATH: `${FIXTURE_DIRECTORY}:${process.env.PATH ?? ""}` } });

/** Sends a prompt the fake model answers, and waits until its answer is on screen. */
async function answeredChat(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "pong");
  await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
}

/** Opens the Usage popover on an open chat, and waits until omp's provider limits are drawn as bars. */
async function openUsage(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /Usage/ }).click();
  const section = page.getByRole("region", { name: "Provider limits" });
  await expect(section).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "anthropic, 5 hour limit" })).toBeVisible({
    timeout: 90_000,
  });
  return section;
}

realTest(
  "#1163: each provider limit is a progress bar with its share, its reset and its colour step",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await answeredChat(page);
    await openUsage(page);

    await expect(
      page.getByRole("progressbar", { name: "anthropic, 5 hour limit" }),
    ).toHaveAttribute("aria-valuenow", "4");
    await expect(page.getByRole("progressbar", { name: "anthropic, 7 day limit" })).toHaveAttribute(
      "data-tone",
      "warning",
    );
    await expect(page.getByRole("progressbar", { name: "cursor, monthly limit" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    const fullest = page.getByRole("progressbar", { name: "openai-codex, 5 hours limit" });
    await expect(fullest).toHaveAttribute("aria-valuenow", "95");
    await expect(fullest).toHaveAttribute("data-tone", "danger");
    await expect(page.getByText(/the fullest of 2 accounts/).first()).toBeVisible();
    await expect(page.getByText(/resets in 2 h 5 min/).first()).toBeVisible();

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1163-usage-light.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#1163: the provider limit bars read in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await answeredChat(page);
  await openUsage(page);
  // An empty bar must still show its track: in dark the track once had the same colour as the panel it sits on.
  const track = page.getByRole("progressbar", { name: "cursor, monthly limit" });
  const panel = page.locator('[role="dialog"][aria-label="Session usage details"]');
  const [trackColour, panelColour] = await Promise.all([
    track.evaluate((element) => getComputedStyle(element).backgroundColor),
    panel.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(trackColour).not.toBe(panelColour);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-1163-usage-dark.png"), fullPage: true });
});

realTest("#1163: the provider limit bars fit at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(420_000);
  const page = await realApp.open();
  // The chat starts at desktop width, where the sidebar's New chat is reachable; then the page narrows.
  await answeredChat(page);
  await page.setViewportSize(NARROW);
  await openUsage(page);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-1163-usage-narrow.png"), fullPage: true });
  // The popup must be on screen and no wider than the 390 px page.
  const popup = page.locator('[role="dialog"][aria-label="Session usage details"]');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  const box = await popup.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});
