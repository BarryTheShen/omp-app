import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * A saved chat whose model is gone (not in omp's catalog) cannot be restored: omp 18.6.3 and later refuse it
 * instead of carrying on with another model. The app must say so in plain words, offer a model picker, and open
 * the chat with the model that is picked. The harness runs omp without a forced `--model`, so omp must restore
 * the saved model, and the fake provider's `fake/fake-model` is the one a person can pick.
 */

const SAVED_MODEL = "fake/gone-model";
const SENTENCE = `This chat used ${SAVED_MODEL}, which is not available any more. Pick another model to open it.`;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 3, 11, 59, 0);

realTest.use({
  defaultModel: false,
  seedEntries: {
    entries: [
      { type: "model_change", model: SAVED_MODEL },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from the saved chat" }],
          timestamp: at,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the saved answer" }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage,
          stopReason: "stop",
          timestamp: at + 1000,
        },
      },
    ],
  },
});

/** The conversation's region: the empty screen's sentence and the chat's messages are read from here. */
function transcript(page: Page) {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The session list's first chat row: the chat the browser opens from the list. It shows once the server answers. */
async function openSavedChatFromList(page: Page): Promise<void> {
  const row = page.getByRole("listbox", { name: "Session list" }).getByRole("option").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
}

async function expectSentenceAndPicker(page: Page): Promise<void> {
  await expect(transcript(page).getByText(SENTENCE)).toBeVisible({ timeout: 60_000 });
  await expect(transcript(page).getByText("This chat could not open")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pick a model", exact: true })).toBeVisible();
}

/** Picks the fake model from the picker: it types to narrow the list, then picks the one row. */
async function pickFakeModel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pick a model", exact: true }).click();
  await page.getByRole("searchbox", { name: "Filter models" }).fill("fake/fake-model");
  await page.getByRole("button", { name: /fake\/fake-model/ }).click();
}

async function expectChatOpened(page: Page): Promise<void> {
  await expect(transcript(page).getByText("hello from the saved chat")).toBeVisible({
    timeout: 60_000,
  });
  await expect(transcript(page).getByText("the saved answer")).toBeVisible({ timeout: 60_000 });
  await expect(transcript(page).getByText(SENTENCE)).toHaveCount(0);
}

realTest(
  "a saved chat whose model is gone says so in plain words and opens with the model picked",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page: Page = await realApp.open();
    // The app starts with no chat open: the person opens the saved chat from the session list.
    await openSavedChatFromList(page);
    await expectSentenceAndPicker(page);
    await expect(page.getByText(/Could not restore model|omp exited/)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-missing-model-light-r1.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-missing-model-dark-r1.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-missing-model-narrow-r1.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Pick a model", exact: true }).click();
    await expect(page.getByRole("button", { name: /fake\/fake-model/ })).toBeVisible({
      timeout: 60_000,
    });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-model-picker-narrow-r1.png"),
      fullPage: true,
    });
    await page.getByRole("searchbox", { name: "Filter models" }).fill("fake/fake-model");
    await page.getByRole("button", { name: /fake\/fake-model/ }).click();

    await expectChatOpened(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a reload shows the same sentence and picker, and the pick opens the chat",
  async ({ realApp }) => {
    const page: Page = await realApp.open();
    await openSavedChatFromList(page);
    await expectSentenceAndPicker(page);

    // The browser had the chat open: after a reload it reopens the chat, and the screen must still offer the picker.
    await page.reload();
    await expectSentenceAndPicker(page);
    await pickFakeModel(page);
    await expectChatOpened(page);
  },
);

realTest(
  "a restart of omp-app shows the sentence again, and the model picked stays with the chat",
  async ({ realApp }) => {
    // A restart drops the page's connection: the browser reports the refused WebSocket, and the app reports that it could
    // not let go of the chat it had open. Both are expected in this case only.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    realApp.allowProblem(/could not let go of a chat on the server/);
    const page: Page = await realApp.open();
    await openSavedChatFromList(page);
    await expectSentenceAndPicker(page);

    // The server restarts: the chat is refused again, and the same page offers the picker.
    const afterRestart = await realApp.restartServer();
    await page.goto(afterRestart);
    await openSavedChatFromList(page);
    await expectSentenceAndPicker(page);
    await pickFakeModel(page);
    await expectChatOpened(page);

    // A second restart: the chat opens with the model picked for it, without asking again.
    const afterSecondRestart = await realApp.restartServer();
    await page.goto(afterSecondRestart);
    await openSavedChatFromList(page);
    await expectChatOpened(page);
  },
);

realTest(
  "with another chat open, clicking the chat whose model is gone opens the picker over it; Escape leaves that chat as it was",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page: Page = await realApp.open();
    const sessions = page.getByRole("complementary", { name: "Sessions" });
    await sessions.getByRole("button", { name: "New chat" }).click();
    await expect(transcript(page).getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });

    await openSavedChatFromList(page);

    // The picker opens at once over the open chat, with the sentence as its first line. The sentence shows once: the
    // sidebar says nothing about it.
    const picker = page.getByRole("dialog", { name: "Pick a model" });
    await expect(picker.getByText(SENTENCE)).toBeVisible({ timeout: 60_000 });
    // The captures show the list, so they wait for the models to load.
    await expect(picker.getByRole("button", { name: /fake\/fake-model/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(SENTENCE)).toHaveCount(1);
    await expect(sessions.getByText(SENTENCE)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-picker-over-chat-light-r1.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-picker-over-chat-dark-r1.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1153-picker-over-chat-narrow-r1.png"),
      fullPage: true,
    });

    // Escape closes the picker and leaves the open chat exactly as it was.
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(transcript(page).getByText("No messages yet.")).toBeVisible();
    await expect(transcript(page).getByText(SENTENCE)).toHaveCount(0);

    // A reload reopens the chat that was open, not the refused one.
    await page.reload();
    await expect(transcript(page).getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(SENTENCE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "with another chat open, the model picked for the chat whose model is gone opens that chat",
  async ({ realApp }) => {
    const page: Page = await realApp.open();
    const sessions = page.getByRole("complementary", { name: "Sessions" });
    await sessions.getByRole("button", { name: "New chat" }).click();
    await expect(transcript(page).getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });

    await openSavedChatFromList(page);
    const picker = page.getByRole("dialog", { name: "Pick a model" });
    await expect(picker.getByText(SENTENCE)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("searchbox", { name: "Filter models" }).fill("fake/fake-model");
    await page.getByRole("button", { name: /fake\/fake-model/ }).click();

    await expectChatOpened(page);
    await expect(picker).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
