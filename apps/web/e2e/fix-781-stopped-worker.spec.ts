import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 781. A worker that stopped without calling yield, and whose session omp disposed, records no end, so the
 * Agent Hub listed nothing for it after a reload. It now sits under Recent as Stopped, and its transcript opens.
 */
realTest(
  "real omp: a worker that stopped without a yield is listed as Stopped under Recent after a reload, and its transcript opens",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");
    // The task returns while the worker still runs in the background. Once its turn ends it is idle, and omp keeps
    // its session open until the app stops.
    await expect(page.getByText(/Background job QuietProbe has completed/).first()).toBeVisible({
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
    await expect(reopened.getByText(/Background job QuietProbe has completed/).first()).toBeVisible(
      {
        timeout: 120_000,
      },
    );
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    const stopped = hub.getByRole("option", { name: /Stopped.*QuietProbe/ });
    await expect(stopped).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByRole("option", { name: /Failed|Cancelled/ })).toHaveCount(0);
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);

    await stopped.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const transcript = reopened.getByRole("region", { name: /^Transcript of QuietProbe/ });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    await expect(transcript.getByText("Quiet probe answered in plain text.").first()).toBeVisible({
      timeout: 60_000,
    });
  },
);

/*
 * Issue 781, review item 1: a page reload with omp still running. The worker is idle, its session is still open and
 * nothing has been disposed, so the hub must still list it as Stopped (not "Nothing here yet"), and its card must not say
 * Complete. The earlier case restarts the app, which disposes the session; this one does not.
 */
realTest(
  "real omp: after a plain page reload, with omp still running, an idle worker is listed as Stopped under Recent and its card does not say Complete",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");
    await expect(page.getByText(/Background job QuietProbe has completed/).first()).toBeVisible({
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
    const stopped = hub.getByRole("option", { name: /Stopped.*QuietProbe/ });
    await expect(stopped).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^task: Complete/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^task: Stopped/ })).toBeVisible();

    await stopped.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(page.getByRole("region", { name: /^Transcript of QuietProbe/ })).toBeVisible({
      timeout: 60_000,
    });
  },
);
