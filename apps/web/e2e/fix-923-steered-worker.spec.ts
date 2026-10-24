/// <reference types="node" />
import { writeFile } from "node:fs/promises";
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
 * Issue #923. The fake model starts a long worker whose command runs until the spec releases it. A message to it while
 * that command runs gets its answer ("pong") at once, and the command moves to the background. omp still lists the worker
 * as running until the command ends, but it refuses Cancel meanwhile (issue #1156): the Agent Hub keeps the worker
 * Running and says why, rather than reading the refusal as Finished.
 */
const TRANSCRIPT = /^Transcript of /;
const REFUSED_CANCEL =
  "omp could not stop this worker now, because it is still running. Try Cancel again.";

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

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

/** The seconds a row shows as "Working · 4 s" or "Working · 1 min 4 s". */
function workingSeconds(text: string): number {
  const match = /Working · (?:(\d+) min )?(\d+) s/.exec(text);
  if (match === null) throw new Error(`no working time in "${text}"`);
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/** Starts a long worker, messages it while its command runs, and returns once its answer is back in the Agent Hub. */
async function steerLongWorker(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
  if ((await showPanels.count()) > 0) await showPanels.first().click();
  await page.getByRole("tab", { name: "Agents" }).click();
  const hub = page.getByRole("region", { name: "Agent Hub" });
  await expect(hub).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

  await sendPrompt(composer, "spawn_held_subagent");
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
  // The worker's answer to this message is the first "pong": omp sends the worker more messages while it runs, and each
  // one gets a "pong" too, so an exact count would fail on a longer run (the strict locator resolved to four).
  await expect(transcript.getByText("pong", { exact: true }).first()).toBeVisible({
    timeout: 180_000,
  });

  await page.getByRole("region", { name: "Worker messages" }).focus();
  await page.keyboard.press("Escape");
  await expect(hub).toBeVisible();
  return hub;
}

/** Cancel on the still-running row while omp waits on the background command: omp refuses, and the row stays Running. */
async function cancelAndExpectRefused(hub: Locator): Promise<void> {
  await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
  await hub.getByRole("button", { name: /Cancel LongProbe/ }).click();
  await expect(hub.getByText(REFUSED_CANCEL)).toBeVisible({ timeout: 15_000 });
  await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1);
  await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(0);
  await expect(hub.getByRole("button", { name: /Cancel LongProbe/ })).toBeVisible();
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a worker that answered a message reads as Running with a moving time, Cancel says omp could not stop it, and the row reads Finished when omp reports the end",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const hub = await steerLongWorker(page);

    // The command still runs, so omp still lists the worker as running: its time moves on rather than freezing.
    const row = hub.getByRole("option", { name: /Running.*LongProbe/ });
    await row.click();
    const firstSeconds = workingSeconds(await row.innerText());
    await expect
      .poll(async () => workingSeconds(await row.innerText()), { timeout: 15_000 })
      .toBeGreaterThan(firstSeconds);

    await cancelAndExpectRefused(hub);

    // The command ends when the spec releases it, not on a clock: the row then reads Finished.
    await writeFile(join(realApp.agentDir, "release-long-probe"), "");
    await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(0);

    await settle(page);
    await expectStyledShell(page);
    await page.screenshot({ path: join(screenshots, "fix-923-hub-light.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1);
    await settle(page);
    await expectStyledShell(page);
    await page.screenshot({ path: join(screenshots, "fix-923-hub-narrow.png"), fullPage: true });
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
    const hub = await steerLongWorker(page);
    await cancelAndExpectRefused(hub);

    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await settle(page);
    await expectStyledShell(page);
    await page.screenshot({ path: join(screenshots, "fix-923-hub-dark.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
