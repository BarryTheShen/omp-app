import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest } from "./real-omp";

/** Pausing a chat (omp's `/pause`, #2766) on real omp: `/pause` in the box, Pause and Resume, Esc, and pause all. */
realTest.describe("pausing a chat", () => {
  realTest.setTimeout(240_000);

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    return page;
  }

  const paused = (page: Page) => page.locator('[data-tour="paused"]');

  async function palette(page: Page, command: string): Promise<void> {
    await page.keyboard.press("Control+k");
    const search = page
      .getByRole("dialog", { name: "Palette", exact: true })
      .getByRole("combobox", { name: "Search the palette" });
    await search.fill(command);
    await search.press("Enter");
  }

  realTest(
    "/pause holds the chat: a message sent waits with no reply, and Esc in the empty box lets it go",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      // As every command in the box: Enter picks it in the `/` menu, Enter again sends it.
      await box.fill("/pause");
      await box.press("Enter");
      await expect(box).toHaveValue(/^\/pause\s*$/);
      await box.press("Enter");
      await expect(paused(page)).toContainText("Paused");
      await expect(paused(page).getByRole("button", { name: "Resume" })).toBeVisible();
      await expect(box).toHaveValue("");

      // Sent while paused, the message waits (omp shows it when the chat goes on), and the model is not asked.
      await box.fill("say hello");
      await box.press("Enter");
      await expect(paused(page)).toContainText("1 message waits", { timeout: 30_000 });
      await expect(box).toHaveValue("");
      const transcript = page.getByRole("region", { name: "Transcript" });
      await page.waitForTimeout(2_000);
      await expect(transcript.getByText("pong", { exact: true })).toHaveCount(0);

      await box.press("Escape");
      await expect(paused(page)).toHaveCount(0);
      await expect(transcript.getByText("say hello", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Pause beside esc to stop holds a working chat, and Resume puts the working row back",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("stream_held");
      await box.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "to stop" })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(paused(page)).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "to stop" })).toHaveCount(0);

      await paused(page).getByRole("button", { name: "Resume" }).click();
      await expect(paused(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

      await writeFile(join(realApp.agentDir, "release-held-reply"), "");
      await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Pause all chats in the palette pauses the open chat, and Resume all chats lets it go",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await palette(page, "Pause all chats");
      await expect(page.getByText("Paused 1 chat.")).toBeVisible({ timeout: 30_000 });
      await expect(paused(page)).toBeVisible();

      await palette(page, "Resume all chats");
      await expect(page.getByText("Resumed 1 chat.")).toBeVisible({ timeout: 30_000 });
      await expect(paused(page)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the chat list in another window marks a paused chat, and the mark goes when it resumes",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      // A reply first, so the chat is saved and listed.
      await box.fill("say hello");
      await box.press("Enter");
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText("pong", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await box.fill("stream_held");
      await box.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "to stop" })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(paused(page)).toBeVisible();

      const other = await realApp.open({ path: "/" });
      const rows = other.getByRole("navigation", { name: "Chats" });
      const pausedRow = rows.getByRole("button", { name: /, paused(,|$)/ });
      await expect(pausedRow).toHaveCount(1, { timeout: 30_000 });

      await paused(page).getByRole("button", { name: "Resume" }).click();
      await expect(pausedRow).toHaveCount(0, { timeout: 30_000 });

      await writeFile(join(realApp.agentDir, "release-held-reply"), "");
      await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
