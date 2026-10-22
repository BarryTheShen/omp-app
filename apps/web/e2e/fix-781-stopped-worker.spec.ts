import { expect, openToolCard, realTest, sendPrompt, startChat } from "./real-omp";

/** The notice a finished worker's line goes in: the one that names the worker and how it ended. */
const NOTICE = '[data-slot="u1-custom-note"]';

/*
 * Issue 781. A worker whose omp shut down before it ended records no end, so the Agent Hub listed nothing for it after
 * a reload. It sits under Recent as Stopped, and its transcript opens. Issue 2300: a worker that finished with a
 * plain-text answer has that answer recorded in its parent chat (omp's `<task-result status="completed">`), so after a
 * restart or a reload it reads as Finished, as it did live. Only a worker with no recorded outcome is Stopped.
 */
realTest(
  "real omp: a worker that finished with a plain-text answer is listed as Finished under Recent after a restart, and its transcript opens",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");
    // The task returns while the worker still runs in the background. Its final answer finishes it, and omp keeps its
    // session open until the app stops.
    await expect(
      page.locator(NOTICE).filter({ hasText: "QuietProbe finished." }).first(),
    ).toBeVisible({
      timeout: 180_000,
    });

    // Stopping the app ends the idle worker's session, which omp records as its exit. Then the app opens again.
    // The old tab cannot reach the stopped app: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_quiet_subagent/ })
      .click();
    // The chat recorded the worker's answer before the restart, so its notice still reads as finished.
    await expect(
      reopened.locator(NOTICE).filter({ hasText: "QuietProbe finished." }).first(),
    ).toBeVisible({
      timeout: 120_000,
    });
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    const finished = hub.getByRole("option", { name: /Finished.*QuietProbe/ });
    await expect(finished).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByRole("option", { name: /Failed|Cancelled|Stopped/ })).toHaveCount(0);
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);

    await finished.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const transcript = reopened.getByRole("region", { name: /^Transcript of QuietProbe/ });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    await expect(transcript.getByText("Quiet probe answered in plain text.").first()).toBeVisible({
      timeout: 60_000,
    });
  },
);

/*
 * Issue 781, review item 1: a page reload with omp still running. The worker finished with a plain-text answer, which the
 * chat records, so the hub lists it as Finished and its card says Complete, as it did live. The restart cases below
 * dispose the session; this one does not.
 */
realTest(
  "real omp: after a plain page reload, with omp still running, a worker that finished with a plain-text answer is listed as Finished under Recent and its card says Complete",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");
    await expect(
      page.locator(NOTICE).filter({ hasText: "QuietProbe finished." }).first(),
    ).toBeVisible({
      timeout: 180_000,
    });

    realApp.allowProblem(/WebSocket connection to .* failed/);
    await page.reload();
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_quiet_subagent/ })
      .click();
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    const finished = hub.getByRole("option", { name: /Finished.*QuietProbe/ });
    await expect(finished).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^task: Complete/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^task: Stopped/ })).toHaveCount(0);

    await finished.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(page.getByRole("region", { name: /^Transcript of QuietProbe/ })).toBeVisible({
      timeout: 60_000,
    });
  },
);

/*
 * Issue 781, the case that stays Stopped: omp shuts down while the worker is still on its one slow step. The worker
 * never finishes, so the chat records no outcome for it, and after the restart the hub lists it as Stopped. Its card
 * must not say Complete.
 */
realTest(
  "real omp: a worker whose omp shut down mid-turn is listed as Stopped under Recent after a restart, and its card does not say Complete",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_long_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const running = page.getByRole("region", { name: "Agent Hub" });
    await expect(running.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    // A plain page reload with omp still running: the worker is still on its slow step, so the hub lists it as Running
    // and its task card's job row says Running, not Completed. (The card's label is the spawn call's, so it reads Complete
    // while the job runs.)
    await page.reload();
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_long_subagent/ })
      .click();
    await page.getByRole("tab", { name: "Agents" }).click();
    await expect(
      page
        .getByRole("region", { name: "Agent Hub" })
        .getByRole("option", { name: /Running.*LongProbe/ }),
    ).toHaveCount(1, { timeout: 120_000 });
    await openToolCard(page.getByTestId("t5-task-card").first());
    await expect(page.locator('[data-slot="t5-task-job"]').first()).toContainText("Running");
    await expect(page.locator('[data-slot="t5-task-job"]').first()).not.toContainText("Completed");

    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_long_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    const stopped = hub.getByRole("option", { name: /Stopped.*LongProbe/ });
    await expect(stopped).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByRole("option", { name: /Finished/ })).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: /^task: Complete/ })).toHaveCount(0);

    await stopped.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(reopened.getByRole("region", { name: /^Transcript of LongProbe/ })).toBeVisible({
      timeout: 60_000,
    });
  },
);
