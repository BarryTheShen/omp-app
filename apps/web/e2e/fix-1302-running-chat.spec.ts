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

realTest.setTimeout(420_000);

/** The prompt the fake model answers with a long streamed reply, which stays open until the spec releases it. */
const PROMPT = "stream_held please";

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The row of the chat whose first reply runs: it has no session file yet, so it is shown as running. */
function runningRow(page: Page): Locator {
  return sessionList(page).getByRole("option", { name: /New chat/ });
}

/** The selected row has its style: a transparent background would mean the style did not load. */
async function expectSelectedRowStyled(page: Page, text: string): Promise<void> {
  const row = page.locator('[role="listbox"][aria-label="Session list"] [data-selected="true"]');
  await expect(row).toContainText(text);
  expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
}

/**
 * Issue 1302. A chat whose first reply is still running is listed at once, marked as running, and it keeps its row
 * through a reload during the run. When the reply ends, the chat's own row takes the running row's place.
 */
realTest(
  "a running first reply has its row in the Sessions list at once, and keeps it through a reload",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(page.getByText("No sessions in this folder")).toBeVisible();

    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });

    // The running chat has its row, marked as running and selected, and the empty text is gone.
    await expect(runningRow(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(runningRow(page).getByText("Running")).toBeVisible();
    await expect(runningRow(page)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No sessions in this folder")).toHaveCount(0);
    await expectSelectedRowStyled(page, "New chat");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1302-running-light.png"),
      fullPage: true,
    });

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectSelectedRowStyled(page, "New chat");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1302-running-dark.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // At 390 px the list is in the sessions drawer, and the running row is in it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(runningRow(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1302-running-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    // A reload during the run shows the same row, and the chat is still running.
    await page.reload();
    await expect(runningRow(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByText("No sessions in this folder")).toHaveCount(0);

    // Releases the held reply: it streams to its end now, as a reply the person is waiting for would.
    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    // The reply ends: the chat's own row, named by its first prompt, takes the running row's place.
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 120_000,
    });
    await expect(sessionList(page).getByRole("option", { name: new RegExp(PROMPT) })).toHaveCount(
      1,
      { timeout: 60_000 },
    );
    await expect(runningRow(page)).toHaveCount(0);
    await expect(sessionList(page).getByText("Running")).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue 1302, the case of a chat left mid-reply: the person starts another chat while the first reply runs. The
 * running chat keeps its row, marked as running, until its reply ends and its file is listed.
 */
realTest(
  "a running first reply that the person leaves keeps its row until the reply ends",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(runningRow(page)).toHaveCount(1, { timeout: 30_000 });

    // A new chat opens. The chat that was left keeps its one row, and no longer reads as selected. Its row is "New chat"
    // while its reply runs and its first prompt once the reply has ended, so the row is found by either name. The wait is
    // for the new chat's empty transcript, a state; omp can take a while to open a chat on a busy machine.
    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    await expect(transcript(page).getByText("No messages yet.")).toBeVisible({ timeout: 120_000 });
    const leftRow = sessionList(page).getByRole("option", {
      name: new RegExp(`New chat|${PROMPT}`),
    });
    await expect(leftRow).toHaveCount(1);
    await expect(leftRow).toHaveAttribute("aria-selected", "false");

    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    // The reply ends: the chat's own row, named by its first prompt, replaces the running row.
    await expect(sessionList(page).getByRole("option", { name: new RegExp(PROMPT) })).toHaveCount(
      1,
      { timeout: 120_000 },
    );
    await expect(runningRow(page)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
