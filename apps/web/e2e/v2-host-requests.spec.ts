import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * The new UI (`apps/ui`, under `/v2/`) answers what omp waits on, above the message box, on real omp: a tool approval
 * with omp's own choices, and omp's questions with one or several answers. A question still open when the page is
 * reloaded shows again.
 */
realTest.describe("new UI approvals and questions", () => {
  realTest.setTimeout(240_000);

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    return page;
  }

  async function send(page: Page, text: string): Promise<void> {
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill(text);
    await box.press("Enter");
  }

  const replies = (page: Page) => page.getByText(/^tool said: /);

  realTest(
    "asks before a write with omp's choices; Approve lets it happen and Deny stops it",
    async ({ realApp }) => {
      // omp reads its approval mode when a chat starts.
      await appendFile(
        join(realApp.agentDir, "config.yml"),
        "\ntools:\n  approvalMode: always-ask\n",
      );
      const page = await newChat(realApp);

      await send(
        page,
        `call_tool write ${JSON.stringify({ path: "notes/a.txt", content: "one\n" })}`,
      );
      const approval = page.getByRole("dialog", { name: "Allow tool: write" });
      await expect(approval).toBeVisible({ timeout: 60_000 });
      const choices = approval.getByRole("group", { name: "Choices" }).getByRole("button");
      await expect(choices.first()).toHaveText("Approve");
      await expect(choices.last()).toHaveText("Deny");
      await approval.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(approval).toBeHidden();
      await expect(replies(page)).toHaveCount(1, { timeout: 60_000 });
      expect(await readFile(join(realApp.folder, "notes/a.txt"), "utf8")).toBe("one\n");

      await send(
        page,
        `call_tool write ${JSON.stringify({ path: "notes/b.txt", content: "two\n" })}`,
      );
      await expect(approval).toBeVisible({ timeout: 60_000 });
      await approval.getByRole("button", { name: "Deny" }).click();
      await expect(approval).toBeHidden();
      await expect(replies(page)).toHaveCount(2, { timeout: 60_000 });
      await expect(readFile(join(realApp.folder, "notes/b.txt"), "utf8")).rejects.toThrow();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "asks omp's questions, marks the recommended answer, and sends one or several answers",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });

      await send(page, "ask_recommended");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      await expect(questions.getByText("Which database?")).toBeVisible();
      await expect(questions.getByText("Recommended")).toBeVisible();
      // One question: Submit, which needs an answer first.
      const submit = questions.getByRole("button", { name: "Submit" });
      await expect(submit).toBeDisabled();
      await questions.getByRole("radio", { name: "SQLite" }).click();
      await submit.click();
      await expect(questions).toBeHidden();
      await expect(replies(page).last()).toContainText("SQLite", { timeout: 60_000 });

      await send(page, "checkbox_ask_two");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      // A click on a single answer chooses it and moves on to the next question, as in omp.
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await expect(questions.getByRole("tab", { name: /^tools/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await questions.getByRole("checkbox", { name: "Read" }).click();
      await questions.getByRole("checkbox", { name: "Bash" }).click();
      await questions.getByRole("button", { name: "Next" }).click();
      await expect(questions).toContainText("All answered · Submit sends them");
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      const last = replies(page).last();
      await expect(last).toContainText("Postgres", { timeout: 60_000 });
      await expect(last).toContainText("Read");
      await expect(last).toContainText("Bash");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("shows a question that is still open again after a reload", async ({ realApp }) => {
    const page = await newChat(realApp);
    const questions = page.getByRole("dialog", { name: "Questions from omp" });
    await send(page, "ask_user");
    await expect(questions).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "ask_user" })
      .click();
    await expect(questions).toBeVisible({ timeout: 60_000 });
    await questions.getByRole("radio", { name: "Postgres" }).click();
    await questions.getByRole("button", { name: "Submit" }).click();
    await expect(questions).toBeHidden();
    await expect(replies(page).last()).toContainText("Postgres", { timeout: 60_000 });

    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "asks several questions one at a time, as omp does: a tab by header each, Next, Review, a note that reaches omp, and Submit (#2795)",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_three");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      const tabs = questions.getByRole("tab");
      await expect(tabs).toHaveText(["Database", "Tools", "Name", "Review"]);
      // One question at a time; the recommended answer is marked, and the highlighted answer's preview shows.
      await expect(questions.getByText("Which database?")).toBeVisible();
      await expect(questions.getByText("Which tools should run?")).toHaveCount(0);
      await expect(questions.getByText("Recommended")).toBeVisible();
      await expect(questions.getByRole("region", { name: "Preview" })).toContainText(
        "preview-marker-3c9e",
      );
      // A click on an answer chooses it and moves on.
      await questions.getByRole("radio", { name: "SQLite" }).click();
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await questions.getByRole("checkbox", { name: "Read" }).click();
      await questions.getByRole("checkbox", { name: "Bash" }).click();
      await questions.getByRole("button", { name: "Note" }).click();
      await questions
        .getByRole("textbox", { name: "Note on your answer" })
        .fill("only the safe ones");
      await questions.getByRole("button", { name: "Next" }).click();
      await expect(questions.getByText("What should the file be called?")).toBeVisible();
      await questions.getByRole("button", { name: "Next" }).click();
      // Review: what is unanswered, then every answer; Submit still sends the rest.
      await expect(tabs.nth(3)).toHaveAttribute("aria-selected", "true");
      await expect(questions).toContainText("1 unanswered · Submit still sends the rest");
      await expect(questions).toContainText("Read, Bash · note: only the safe ones");
      await expect(questions).toContainText("Unanswered");
      // A tab goes back, and the answer is still there.
      await tabs.nth(0).click();
      await expect(questions.getByRole("radio", { name: "SQLite" })).toBeChecked();
      await tabs.nth(3).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      const reply = replies(page).last();
      await expect(reply).toContainText("SQLite", { timeout: 60_000 });
      await expect(reply).toContainText("note: only the safe ones");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "more question tabs than fit: the selected one comes into view, and the wheel scrolls the row sideways (#2802)",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.setViewportSize({ width: 640, height: 720 });
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_six");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      const row = questions.getByRole("tablist", { name: "Questions" });
      const tabs = questions.getByRole("tab");
      await expect(tabs).toHaveCount(7);
      expect(await row.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

      // Next, to the last question: its tab is in view, not beyond the row's end.
      for (let step = 0; step < 5; step += 1) {
        await questions.getByRole("button", { name: "Next" }).click();
      }
      await expect(tabs.nth(5)).toHaveAttribute("aria-selected", "true");
      await expect(tabs.nth(5)).toBeInViewport({ ratio: 1 });

      // Back to the first, then the wheel turned over the row scrolls it sideways.
      await tabs.nth(0).click();
      await expect(tabs.nth(0)).toBeInViewport({ ratio: 1 });
      const before = await row.evaluate((element) => element.scrollLeft);
      await row.hover();
      await page.mouse.wheel(0, 240);
      await expect
        .poll(() => row.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(before);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "takes at most about half the chat and scrolls inside; Hide folds it to one line until Show, Alt+H too; omp's keys answer (#2795)",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.setViewportSize({ width: 1280, height: 480 });
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      const folded = page.getByRole("region", { name: "Questions from omp, hidden" });
      await send(page, "ask_three");
      await expect(questions).toBeVisible({ timeout: 60_000 });

      // At most about half the chat's height, the rest scrolling inside it; the conversation keeps at least a quarter.
      const pane = page.locator("[data-chat-pane]").filter({ has: questions });
      const transcript = pane.locator(".tl-scroll");
      // The chat's own column: the transcript's, the questions' and the message box's.
      const columnBox = await transcript.locator("xpath=../..").boundingBox();
      const dialogBox = await questions.boundingBox();
      const transcriptBox = await transcript.boundingBox();
      if (columnBox === null || dialogBox === null || transcriptBox === null)
        throw new Error("no chat column, questions or transcript");
      expect(dialogBox.height).toBeLessThanOrEqual(columnBox.height * 0.55 + 1);
      expect(transcriptBox.height).toBeGreaterThanOrEqual(columnBox.height * 0.25 - 1);
      expect(
        await questions
          .getByRole("tabpanel")
          .evaluate((panel) => panel.scrollHeight > panel.clientHeight),
      ).toBe(true);

      // Hide folds the questions into one line; Show brings them back as they were.
      await questions.getByRole("radio", { name: "SQLite" }).click();
      await questions.getByRole("button", { name: "Hide" }).click();
      await expect(questions).toBeHidden();
      await expect(folded).toContainText("Which tools should run?");
      await expect(folded).toContainText("+2 more");
      await folded.getByRole("button", { name: "Show" }).click();
      await expect(questions.getByRole("tab", { name: /^Tools/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      // Alt+H from the message box hides them, and shows them again.
      const box = page.getByRole("textbox", { name: "Message" });
      await box.press("Alt+h");
      await expect(folded).toBeVisible();
      await box.press("Alt+h");
      await expect(questions).toBeVisible();

      // omp's keys: Enter chooses the focused answer and moves on, Shift+Tab goes back, N opens a note, Esc closes an
      // empty note and then skips.
      await questions.getByRole("tab", { name: /^Database/ }).click();
      await questions.getByRole("radio", { name: "Postgres" }).focus();
      await page.keyboard.press("Enter");
      await expect(questions.getByRole("tab", { name: /^Tools/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.keyboard.press("Shift+Tab");
      await expect(questions.getByRole("tab", { name: /^Database/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(questions.getByRole("radio", { name: "Postgres" })).toBeChecked();
      await page.keyboard.press("n");
      const note = questions.getByRole("textbox", { name: "Note on your answer" });
      await expect(note).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(questions).toBeHidden();
      await expect(folded).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone the questions fit the screen's width and leave the top of the chat in view (#2795)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("ask_three");
      await page.getByRole("button", { name: "Send" }).tap();
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(questions).toBeVisible({ timeout: 60_000 });
      const pane = page.locator("[data-chat-pane]").filter({ has: questions });
      const paneBox = await pane.boundingBox();
      const dialogBox = await questions.boundingBox();
      if (paneBox === null || dialogBox === null) throw new Error("no pane or questions");
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
      expect(dialogBox.height).toBeLessThanOrEqual(paneBox.height * 0.7 + 1);
      // Every button of the bar is on screen and can be tapped.
      for (const name of ["Hide", "Note", "Skip", "Next"]) {
        await expect(questions.getByRole("button", { name, exact: true })).toBeInViewport();
      }
      await questions.getByRole("button", { name: "Hide", exact: true }).tap();
      await expect(
        page.getByRole("region", { name: "Questions from omp, hidden" }),
      ).toBeInViewport();
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
