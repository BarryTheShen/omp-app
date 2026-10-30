import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest } from "./real-omp";

/**
 * The new UI (`apps/ui`, under `/v2/`) answers what omp waits on, above the message box, on real omp: a tool approval
 * with omp's own choices, and omp's questions with one or several answers. A question still open when the page is
 * reloaded shows again.
 */
realTest.describe("new UI approvals and questions", () => {
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
      const sendAnswers = questions.getByRole("button", { name: "Send answers" });
      await expect(sendAnswers).toBeDisabled();
      await questions.getByRole("radio", { name: "SQLite" }).click();
      await sendAnswers.click();
      await expect(questions).toBeHidden();
      await expect(replies(page).last()).toContainText("SQLite", { timeout: 60_000 });

      await send(page, "checkbox_ask_two");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("checkbox", { name: "Read" }).click();
      await questions.getByRole("checkbox", { name: "Bash" }).click();
      await questions.getByRole("button", { name: "Send answers" }).click();
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
    await questions.getByRole("button", { name: "Send answers" }).click();
    await expect(questions).toBeHidden();
    await expect(replies(page).last()).toContainText("Postgres", { timeout: 60_000 });

    expect(realApp.problems).toEqual([]);
  });
});
