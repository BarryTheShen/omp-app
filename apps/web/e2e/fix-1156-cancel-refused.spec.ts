/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1156. The fake model starts a long worker whose command runs 60 s. A message sent while that command runs is
 * answered at once and moves the command to the background, so the worker waits for it. omp still lists the worker as
 * running, but it refuses Cancel and a further message. The Agent Hub must not say Finished or Cancelled for a refusal:
 * it says in plain words what happened, keeps the worker Running, and offers Cancel again.
 */
const REFUSED_CANCEL =
  "omp could not stop this worker now, because it is still running. Try Cancel again.";
const REFUSED_STEER = "omp did not take the message. Your text is still here.";
const FINISHED_BY_OMP =
  "omp is no longer running this worker; it finished when its last turn ended.";
const TRANSCRIPT = /^Transcript of /;

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** Starts a long worker, messages it while its command runs, and returns once its answer is back in the Agent Hub. */
async function steerLongWorker(page: Page): Promise<{ hub: Locator; answeredAt: number }> {
  const composer = await startChat(page);
  await page.getByRole("tab", { name: "Agents" }).click();
  const hub = page.getByRole("region", { name: "Agent Hub" });
  await expect(hub).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

  await sendPrompt(composer, "spawn_long_subagent");
  const running = hub.getByRole("option", { name: /Running.*LongProbe/ });
  await expect(running).toHaveCount(1, { timeout: 120_000 });
  await running.click();
  await hub.getByRole("button", { name: "Open transcript" }).click();

  const transcript = page.getByRole("region", { name: TRANSCRIPT });
  await expect(transcript).toBeVisible({ timeout: 60_000 });
  const editor = page.getByRole("textbox", { name: "Message to this worker" });
  await expect(editor).toBeEnabled({ timeout: 60_000 });
  await editor.fill("steer_probe: please stop now");
  await editor.press("Enter");
  await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 180_000 });
  const answeredAt = Date.now();

  await page.getByRole("region", { name: "Worker messages" }).focus();
  await page.keyboard.press("Escape");
  await expect(hub).toBeVisible();
  return { hub, answeredAt };
}

/** Cancel on the running row, while omp waits on the background command: the row keeps its state and says why. */
async function cancelAndExpectRefused(hub: Locator): Promise<void> {
  await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
  await hub.getByRole("button", { name: /Cancel LongProbe/ }).click();
  await expect(hub.getByText(REFUSED_CANCEL)).toBeVisible({ timeout: 15_000 });
  await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1);
  await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(0);
  await expect(hub.getByRole("option", { name: /Cancelled.*LongProbe/ })).toHaveCount(0);
  await expect(hub.getByText(FINISHED_BY_OMP)).toHaveCount(0);
  await expect(hub.getByRole("button", { name: /Cancel LongProbe/ })).toBeVisible();
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a Cancel that omp refuses on a worker waiting for a background command says so and keeps the row Running, a second message is refused in plain words, and the row reads Finished when omp reports the end",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const { hub, answeredAt } = await steerLongWorker(page);
    await cancelAndExpectRefused(hub);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1156-hub-light.png"), fullPage: true });

    // A second message while the worker waits: omp refuses it, the text stays, and the words say why.
    await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const editor = page.getByRole("textbox", { name: "Message to this worker" });
    await editor.fill("steer_probe: a second message");
    await editor.press("Enter");
    await expect(page.getByText(REFUSED_STEER)).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveValue("steer_probe: a second message");
    await page.getByRole("region", { name: "Worker messages" }).focus();
    await page.keyboard.press("Escape");
    await expect(hub).toBeVisible();
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1);

    // omp reports the end once the command finishes, about a minute after the answer.
    await page.waitForTimeout(Math.max(0, answeredAt + 75_000 - Date.now()));
    await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1, {
      timeout: 30_000,
    });

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a Cancel that omp refuses reads in plain words in the dark theme, and the row stays Running",
  async ({ realApp }) => {
    // The stored theme is applied before the first paint, so the page renders dark from its first frame.
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const { hub } = await steerLongWorker(page);
    await cancelAndExpectRefused(hub);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1156-hub-dark.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: at 390 px the refused Cancel's words fit the Agent Hub and the row stays Running",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const { hub } = await steerLongWorker(page);
    await cancelAndExpectRefused(hub);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(hub.getByText(REFUSED_CANCEL)).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1156-hub-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
