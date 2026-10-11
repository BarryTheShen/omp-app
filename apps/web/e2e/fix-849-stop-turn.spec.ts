/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * Issue #849. A bash call's card offers Stop turn while its command runs, and the button stops the turn the way the
 * composer's stop does. The fake model runs `slow_tool`: a bash call that sleeps 7 seconds, so each capture is taken
 * while the button is still on the card.
 *
 * A worker's card is not the chat's turn: `spawn_long_subagent` starts a worker whose `sleep 60` runs after the chat's
 * turn has settled. That worker's card, in the chat's task card, must not offer Stop turn.
 */

/** The app's styles are loaded: the shell's background is the theme's background token, not the browser default. */
async function expectStyledShell(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.actual).toBe(colors.token);
}

/** Sends the slow bash call in an open chat and returns its card once the Stop turn button is on it. */
async function sendSlowBash(page: Page, composer: Locator) {
  await sendPrompt(composer, "slow_tool");
  const card = page.getByTestId("u3-bash-card");
  const stop = card.getByRole("button", { name: "Stop turn" });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  return { card, stop };
}

/**
 * Starts a worker that runs `sleep 60`, and waits until the chat's turn has settled while the worker's card is still
 * running. The card is found in the chat's task card by its command, so it is the worker's, not the chat's own call.
 */
async function startLongWorker(page: Page, composer: Locator) {
  await sendPrompt(composer, "spawn_long_subagent");
  const worker = page
    .locator('[data-slot="t5-task-transcripts"]')
    .getByTestId("u3-bash-card")
    .filter({ hasText: "long-probe-done" });
  await expect(worker).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(worker).toContainText("Running");
  return worker;
}

/**
 * The chat's own bash call still has its Stop turn while the chat's turn runs, and the worker's card gains none. This
 * runs after the worker's capture: the chat follows its new output and scrolls the worker's card out of view.
 */
async function expectOwnStopBesideWorker(page: Page, composer: Locator, worker: Locator) {
  await sendPrompt(composer, "slow_tool");
  const own = page.getByTestId("u3-bash-card").filter({ hasText: "slow-tool-done" });
  await expect(own.getByRole("button", { name: "Stop turn" })).toBeVisible({ timeout: 120_000 });
  await expect(worker.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
}

/**
 * The worker's card, centred, so the chat's sticky footer does not cover its command or the row under it.
 */
async function captureWorker(worker: Locator, path: string) {
  await worker.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await worker.screenshot({ path });
}

realTest.setTimeout(420_000);

realTest("real omp: a running bash card's Stop turn stops the turn", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  const composer = await startChat(page);
  const { card, stop } = await sendSlowBash(page, composer);
  await expectStyledShell(page);
  await card.screenshot({ path: join(screenshots, "fix-849-stop-light.png") });

  await stop.click();
  await expect(card.getByRole("button", { name: "Stop turn" })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(card.locator('[data-slot="u3-tool-card-status"]')).not.toHaveText("Running");
  expect(realApp.problems).toEqual([]);
});

realTest(
  "real omp: a running bash card reads its Stop turn in the dark theme",
  async ({ realApp }) => {
    // The stored theme is applied before the first paint, so the page renders dark from its first frame.
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    const { card } = await sendSlowBash(page, composer);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await expectStyledShell(page);
    await card.screenshot({ path: join(screenshots, "fix-849-stop-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("real omp: a running bash card reads its Stop turn at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  // The chat starts at desktop width, where the sessions sidebar that starts it is shown; then the page narrows.
  const composer = await startChat(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { card } = await sendSlowBash(page, composer);
  await expectStyledShell(page);
  await card.screenshot({ path: join(screenshots, "fix-849-stop-narrow.png") });
  expect(realApp.problems).toEqual([]);
});

realTest(
  "real omp: a worker's running bash card has no Stop turn in the light theme",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    const worker = await startLongWorker(page, composer);
    await expect(worker.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
    await expectStyledShell(page);
    await captureWorker(worker, join(screenshots, "fix-849-worker-light.png"));
    await expectOwnStopBesideWorker(page, composer, worker);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a worker's running bash card has no Stop turn in the dark theme",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    const worker = await startLongWorker(page, composer);
    await expect(worker.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
    await expectStyledShell(page);
    await captureWorker(worker, join(screenshots, "fix-849-worker-dark.png"));
    await expectOwnStopBesideWorker(page, composer, worker);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a worker's running bash card has no Stop turn at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await startLongWorker(page, composer);
    await expect(worker.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
    await expectStyledShell(page);
    await captureWorker(worker, join(screenshots, "fix-849-worker-narrow.png"));
    await expectOwnStopBesideWorker(page, composer, worker);
    expect(realApp.problems).toEqual([]);
  },
);
