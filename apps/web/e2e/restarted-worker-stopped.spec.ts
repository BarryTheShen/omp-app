import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 1337. A worker still running when the app restarts is killed before it records an end. Its transcript stays on
 * disk, but the Agent Hub listed nothing: its status was unknown, and the finished-worker source drops unknown workers.
 * Once no live omp holds the worker's own session, the worker is listed as Stopped and its transcript opens read-only.
 * Captures: light, dark and 390 px wide.
 */

const TRANSCRIPT = '[data-slot="p1-agent-transcript"]';
const COULD_NOT_READ = "The transcript could not be read";
/** The steerable worker's task text: it is in the transcript, written by omp before the restart. */
const TASK_TEXT = "nested_steer_child";

realTest.setTimeout(420_000);

realTest(
  "real omp: a worker still running at restart is listed as Stopped, and its transcript opens read-only",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // The steerable worker keeps taking steps until a steer reaches it, so it is still running when the app restarts.
    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*SteerProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    // The first page is ended before the restart, so it does not keep retrying its socket against the new server.
    await page.close();
    await realApp.restartServer();

    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_steerable_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const reopenedHub = reopened.getByRole("region", { name: "Agent Hub" });
    await expect(reopenedHub.getByRole("option", { name: /Stopped.*SteerProbe/ })).toHaveCount(1, {
      timeout: 90_000,
    });
    await reopenedHub.getByRole("option", { name: /Stopped.*SteerProbe/ }).click();
    await reopenedHub.getByRole("button", { name: "Open transcript" }).click();
    const region = reopened.getByRole("region", { name: /^Transcript of SteerProbe/ });
    await expect(region.locator(TRANSCRIPT)).toContainText(TASK_TEXT, { timeout: 60_000 });
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(reopened);
    await reopened.screenshot({ path: join(screenshots, "restarted-worker-stopped-light.png") });
    await reopened.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(reopened);
    await reopened.screenshot({ path: join(screenshots, "restarted-worker-stopped-dark.png") });
    await reopened.evaluate(() => document.documentElement.classList.remove("dark"));
    await reopened.setViewportSize({ width: 390, height: 844 });
    await reopened.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(region.locator(TRANSCRIPT)).toContainText(TASK_TEXT, { timeout: 60_000 });
    await waitForFiniteAnimations(reopened);
    await reopened.screenshot({ path: join(screenshots, "restarted-worker-stopped-390.png") });

    expect(realApp.problems).toEqual([]);
  },
);
