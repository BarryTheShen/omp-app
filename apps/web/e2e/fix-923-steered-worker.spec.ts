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
 * Issue #923. The fake model starts a long worker whose command runs 60 s. A message to it while that command runs
 * gets its answer ("pong") at once; omp reports the worker ended only when the command ends, about a minute later.
 * In that window the Agent Hub used to show the worker as Running with a frozen timer, and Cancel answered that the
 * worker had already finished.
 */
const TRANSCRIPT = /^Transcript of /;
const ALREADY_FINISHED =
  "omp is no longer running this worker; it finished when its last turn ended.";

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

/** Cancel on the still-running row: omp answers that the worker has already finished, so the row reads Finished. */
async function cancelAndExpectFinished(hub: Locator): Promise<void> {
  await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
  await hub.getByRole("button", { name: /Cancel LongProbe/ }).click();
  await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(0);
  await expect(hub.getByRole("button", { name: /^Cancel / })).toHaveCount(0);
  await expect(hub.getByText(ALREADY_FINISHED)).toBeVisible();
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a worker that answered a message reads as Running with a moving time, Cancel reads it as Finished, and the row holds when omp reports the end",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const { hub, answeredAt } = await steerLongWorker(page);

    // The command still runs, so omp still lists the worker as running: its time moves on rather than freezing.
    const row = hub.getByRole("option", { name: /Running.*LongProbe/ });
    await row.click();
    const firstSeconds = workingSeconds(await row.innerText());
    await expect
      .poll(async () => workingSeconds(await row.innerText()), { timeout: 15_000 })
      .toBeGreaterThan(firstSeconds);

    await cancelAndExpectFinished(hub);

    // omp reports the end once the command finishes, about a minute after the answer; the row keeps its state.
    await page.waitForTimeout(Math.max(0, answeredAt + 75_000 - Date.now()));
    await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1);
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
  "real omp: a worker cancelled after a message reads as Finished in the dark theme",
  async ({ realApp }) => {
    // The stored theme is applied before the first paint, so the page renders dark from its first frame.
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const { hub } = await steerLongWorker(page);
    await cancelAndExpectFinished(hub);

    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await settle(page);
    await expectStyledShell(page);
    await page.screenshot({ path: join(screenshots, "fix-923-hub-dark.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
