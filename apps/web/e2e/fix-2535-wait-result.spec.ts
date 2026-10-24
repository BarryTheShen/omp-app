import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 2535: a worker the parent collects with `wait` finishes as Finished, and still does after the app restarts. omp
 * writes the worker's result into the `wait` tool result, which the app did not read, so the restarted app showed Stopped.
 * The worker answers in plain text and never yields, so only its recorded result can say it finished.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });
realTest.setTimeout(300_000);

realTest(
  "a worker collected with wait shows Finished after the app restarts, not Stopped (issue 2535)",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
    if ((await showPanels.count()) > 0) await showPanels.first().click();
    await sendPrompt(composer, "spawn_wait_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Finished.*WaitProbe/ })).toHaveCount(1, {
      timeout: 180_000,
    });

    // The old tab cannot reach the restarted app: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_wait_subagent/ })
      .click();
    const showReopenedPanels = reopened.getByRole("button", { name: /show panels sidebar/i });
    if ((await showReopenedPanels.count()) > 0) await showReopenedPanels.first().click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const reopenedHub = reopened.getByRole("region", { name: "Agent Hub" });
    await expect(reopenedHub.getByRole("option", { name: /Finished.*WaitProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(reopenedHub.getByRole("option", { name: /Stopped/ })).toHaveCount(0);
  },
);
