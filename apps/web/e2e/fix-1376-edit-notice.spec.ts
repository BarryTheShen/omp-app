import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * A `count_reply <tag>` answer reads `count-<n> <tag>`, so each test waits for its own answer by its tag
 * (packages/omp-rpc/scripts/fake-openai-server.ts).
 */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

/** A transcript row by its role, found by the text it shows. */
function row(page: Page, role: "user" | "assistant", text: string) {
  return page.locator(`[data-slot="u1-message-row"][data-role="${role}"]`, { hasText: text });
}

/** The notice an edit leaves in the chat it opened. */
function editNotice(page: Page) {
  return page
    .getByRole("status")
    .filter({ hasText: "Sent in this new chat, branched from the original." });
}

/** The notice while the edited chat has not reported that its run is settled. */
function pendingEditNotice(page: Page) {
  return page.getByRole("status").filter({
    hasText: "Waiting for the edited message to finish in this chat.",
  });
}

/** Opens a chat, sends a prompt, and edits that prompt to `text`; the edit opens a new chat. */
async function editFirstMessageTo(page: Page, text: string): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "count_reply first");
  await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
  const firstTurn = row(page, "user", "count_reply first");
  await firstTurn.hover();
  await firstTurn.getByRole("button", { name: "Edit", exact: true }).click();
  const editorInput = page
    .getByRole("region", { name: "Editing an earlier message" })
    .getByRole("textbox", { name: "Edit message" });
  await editorInput.fill(text);
  await editorInput.press("Enter");
}

/** Opens a chat, sends a prompt, and edits it into a new chat; returns once the edit's notice shows. */
async function editIntoNewChat(page: Page): Promise<void> {
  await editFirstMessageTo(page, "count_reply second");
  await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
  await expect(editNotice(page)).toBeVisible({ timeout: 60_000 });
}

realTest(
  "an edit's notice has a Dismiss control, and Dismiss ends the notice",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editIntoNewChat(page);

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1376-notice-light.png"), fullPage: true });

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1376-notice-dark.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1376-notice-390.png"), fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(editNotice(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  },
);

realTest(
  "an edit's notice ends once the person sends another message",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editIntoNewChat(page);

    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), "count_reply third");
    await expect(answerTo(page, "third")).toBeVisible({ timeout: 60_000 });
    await expect(editNotice(page)).toHaveCount(0);
  },
);

realTest(
  "an edit's notice ends when the person opens another chat, and does not come back",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editIntoNewChat(page);

    await startChat(page);
    await expect(editNotice(page)).toHaveCount(0);

    await page.getByRole("option", { name: /count_reply second/ }).click();
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    await expect(editNotice(page)).toHaveCount(0);
  },
);

realTest(
  "a follow-up queued while the edit's run is still going ends the notice",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    // The edit's run sleeps in bash for 20 seconds, so its turn is still going when the follow-up is queued.
    await editFirstMessageTo(page, "run_queued_pair");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(pendingEditNotice(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1376-notice-pending.png"),
      fullPage: true,
    });
    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.fill("follow later please");
    await composer.press("Control+Enter");
    // Ctrl+Enter queues a follow-up under "After this turn": omp accepted it into the queue.
    await expect(
      page
        .getByRole("complementary", { name: "Queued messages" })
        .getByRole("region", { name: "After this turn" })
        .getByText("follow later please", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editNotice(page)).toHaveCount(0);

    // The queued follow-up goes out once the turn yields, and the queue empties.
    await expect(page.getByRole("complementary", { name: "Queued messages" })).toHaveCount(0, {
      timeout: 90_000,
    });
  },
);
