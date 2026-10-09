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

realTest.setTimeout(300_000);

/** The sidebar's New chat button, the one `startChat` clicks. */
function newChatButton(page: Page): Locator {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/**
 * Opens a new chat while `leaving` (the first prompt of the chat on screen) is shown. The sidebar starts the
 * chat asynchronously: the old transcript must be gone before the test types, or the text lands in the old chat.
 */
async function openNewChat(page: Page, leaving: string): Promise<void> {
  await newChatButton(page).click();
  await expect(transcript(page).getByText(leaving, { exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

/** Opens a listed chat by its first prompt, and waits until its transcript is the one on screen. */
async function openListedChat(page: Page, firstPrompt: string): Promise<void> {
  await sessionList(page)
    .getByRole("option", { name: new RegExp(firstPrompt) })
    .click();
  await expect(transcript(page).getByText(firstPrompt, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

realTest(
  "the text typed in an unsent new chat comes back in the next new chat, and after a reload",
  async ({ realApp }) => {
    const app = await realApp.open();
    const first = await startChat(app);
    await sendPrompt(first, "chat A seed");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(sessionList(app).getByRole("option")).toHaveCount(1);

    await openNewChat(app, "chat A seed");
    await composer(app).fill("unsent draft B");
    await expect(composer(app)).toHaveValue("unsent draft B");

    // Chat B has no prompt, so it is not listed. Switching to chat A shows none of B's text.
    await openListedChat(app, "chat A seed");
    await expect(composer(app)).toHaveValue("");
    await expect(sessionList(app).getByRole("option")).toHaveCount(1);

    // New chat again: the text comes back in the new chat's composer.
    await openNewChat(app, "chat A seed");
    await expect(composer(app)).toHaveValue("unsent draft B", { timeout: 30_000 });
    await expect(sessionList(app).getByRole("option")).toHaveCount(1);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-817-new-chat-draft-back.png"),
      fullPage: true,
    });

    // A reload keeps it: the app reopens this new chat, and its text is still there.
    await app.reload();
    await expect(composer(app)).toHaveValue("unsent draft B", { timeout: 60_000 });
    await expect(sessionList(app).getByRole("option")).toHaveCount(1);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-817-new-chat-draft-after-reload.png"),
      fullPage: true,
    });

    // The same restored draft in dark mode, then at a phone width. Styles must have loaded before each capture.
    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await expect(composer(app)).toHaveValue("unsent draft B");
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-817-new-chat-draft-dark.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));
    await app.setViewportSize({ width: 390, height: 844 });
    await expect(composer(app)).toBeVisible();
    await expect(composer(app)).toHaveValue("unsent draft B");
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-817-new-chat-draft-narrow.png"),
      fullPage: true,
    });
  },
);

realTest(
  "a prompt sent from a new chat clears the new-chat draft, and the sent chat keeps its own later draft",
  async ({ realApp }) => {
    const app = await realApp.open();
    const first = await startChat(app);
    await sendPrompt(first, "chat A seed");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    await openNewChat(app, "chat A seed");
    await sendPrompt(composer(app), "chat B sent");
    await expect(transcript(app).getByText("chat B sent", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    await composer(app).fill("chat B follow-up draft");
    await expect(composer(app)).toHaveValue("chat B follow-up draft");
    await openListedChat(app, "chat A seed");
    await expect(transcript(app).getByText("chat B sent", { exact: true })).toHaveCount(0);
    await expect(composer(app)).toHaveValue("");

    // A new chat after the sent one starts empty: the prompt sent from B left no new-chat draft behind.
    await openNewChat(app, "chat A seed");
    await expect(composer(app)).toHaveValue("");

    // Chat B keeps the draft it had: it is its own, not the new-chat draft.
    await openListedChat(app, "chat B sent");
    await expect(composer(app)).toHaveValue("chat B follow-up draft", { timeout: 60_000 });
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-817-sent-chat-keeps-its-draft.png"),
      fullPage: true,
    });
  },
);
