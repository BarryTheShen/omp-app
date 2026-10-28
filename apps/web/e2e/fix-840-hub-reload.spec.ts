import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  openAllToolCards,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
} from "./real-omp";

/**
 * Issue #840. The Agent Hub listed a finished worker until the page reloaded, then showed "Nothing here yet":
 * omp forgets a finished worker, and the app's roster never read the chat's transcripts, which are the only
 * record left. The live playground read them, so its own reload test passed while the app did not. This drives
 * the app's own Agents tab.
 */
realTest(
  "real omp: a finished worker stays under Recent in the Agent Hub after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    // The task card starts as one line (#1162), and its body holds the worker's result: open it before reading that.
    await expect(page.getByTestId("t5-task-card").first()).toBeVisible({ timeout: 120_000 });
    await openToolCard(page.getByTestId("t5-task-card").first());
    // omp 18.12 gives the task subagent no yield tool, so its final message is the result, shown in the task card. An
    // omp that still has the yield tool shows it in a yield card inside the task card, so each card is opened as it
    // appears until the result shows.
    await expect
      .poll(
        async () => {
          await openAllToolCards(page);
          return page.getByText("Nested probe completed.").first().isVisible();
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    // The Panels start closed on a first run (#2570): open them to reach the Agents tab.
    await page.getByRole("button", { name: "Show panels sidebar" }).click();
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    await page.reload();
    // The chat reopens by itself. The card starts as one line again, so it is opened before the hub is read.
    await expect(page.getByTestId("t5-task-card").first()).toBeVisible({ timeout: 120_000 });
    await openToolCard(page.getByTestId("t5-task-card").first());
    // omp 18.12 gives the task subagent no yield tool, so its final message is the result, shown in the task card. An
    // omp that still has the yield tool shows it in a yield card inside the task card, so each card is opened as it
    // appears until the result shows.
    await expect
      .poll(
        async () => {
          await openAllToolCards(page);
          return page.getByText("Nested probe completed.").first().isVisible();
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    // The Panels stay open across the reload (the person's choice is remembered); open them if they are not.
    const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
    if ((await showPanels.count()) > 0) await showPanels.first().click();
    await page.getByRole("tab", { name: "Agents" }).click();
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-840-hub-after-reload.png") });
  },
);
