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
      /^Message /,
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
    "asks omp's form: what the form ticks starts ticked, and one or several answers go",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });

      await send(page, "ask_recommended");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      await expect(questions.getByText("Which database?")).toBeVisible();
      // The form ticks SQLite: it starts ticked, and Submit sends it untouched.
      await expect(questions.getByRole("radio", { name: "SQLite" })).toBeChecked();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      await expect(replies(page).last()).toContainText("SQLite", { timeout: 60_000 });

      await send(page, "checkbox_ask_two");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      // Both questions in the one card, in the order asked.
      await expect(questions.getByText("Which database?")).toBeVisible();
      await expect(questions.getByText("Which tools should run?")).toBeVisible();
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("checkbox", { name: "Read" }).click();
      await questions.getByRole("checkbox", { name: "Bash" }).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      const last = replies(page).last();
      await expect(last).toContainText("Postgres", { timeout: 60_000 });
      await expect(last).toContainText("Read");
      await expect(last).toContainText("Bash");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "your own answer to omp's question takes several lines: Shift+Enter starts a line, Enter sends both",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_user");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      await questions.getByRole("radio", { name: "Other…" }).click();
      const own = questions.getByRole("textbox", { name: "Your own answer: Which database?" });
      await own.click();
      await page.keyboard.type("MySQL for now,");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("then Postgres once the data outgrows it");
      await expect(own).toHaveValue("MySQL for now,\nthen Postgres once the data outgrows it");
      await expect(questions).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(questions).toBeHidden();
      const last = replies(page).last();
      await expect(last).toContainText("MySQL for now,", { timeout: 60_000 });
      await expect(last).toContainText("then Postgres once the data outgrows it");
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
    "asks several questions in one card, in the order asked, each under its heading, and sends what is answered",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_three");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      const [database, tools, name] = ["Database", "Tools", "Name"].map((title) =>
        questions.getByRole("region", { name: title }),
      );
      if (database === undefined || tools === undefined || name === undefined)
        throw new Error("three parts");
      const tops: number[] = [];
      for (const part of [database, tools, name]) {
        await expect(part).toBeAttached();
        tops.push(await part.evaluate((element) => element.getBoundingClientRect().top));
      }
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
      await expect(database.getByRole("radio", { name: "SQLite" })).toBeChecked();
      await tools.getByRole("checkbox", { name: "Read" }).click();
      await tools.getByRole("checkbox", { name: "Bash" }).click();
      // The file's name is left unanswered: the form goes without one.
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      const reply = replies(page).last();
      await expect(reply).toContainText("SQLite", { timeout: 60_000 });
      await expect(reply).toContainText("Read");
      await expect(reply).toContainText("Bash");
      await expect(reply).not.toContainText("notes.md");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the card refuses what omp's form refuses, in omp's words, and a number reaches omp as a number",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_checked");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      const submit = questions.getByRole("button", { name: "Submit" });
      await submit.click();
      await expect(questions.getByText("Required", { exact: true })).toHaveCount(2);
      const workers = questions.getByRole("spinbutton", { name: "Workers" });
      await workers.fill("9");
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await submit.click();
      await expect(questions.getByText("Must be at most 8")).toBeVisible();
      await expect(questions).toBeVisible();
      await workers.fill("4");
      await submit.click();
      await expect(questions).toBeHidden();
      const reply = replies(page).last();
      await expect(reply).toContainText('"workers": 4', { timeout: 60_000 });
      await expect(reply).toContainText('"db": "Postgres"');
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a form's own script, click handler and remote style do nothing in the page; its picture shows",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const alerts: string[] = [];
      page.on("dialog", (dialog) => {
        alerts.push(dialog.message());
        void dialog.dismiss();
      });
      const remote: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("remote-style")) remote.push(request.url());
      });
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_unsafe");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      // The form's own style would hide its text; the card draws it.
      await expect(questions.getByText("Which database?")).toBeVisible();
      await questions.getByText("Which database?").click();
      await expect(questions.getByRole("img", { name: "A dot" })).toHaveAttribute(
        "src",
        /^data:image\/png;base64,/,
      );
      expect(await questions.locator("script, link, style, [onclick], [onerror]").count()).toBe(0);
      expect(
        await page.evaluate(() => {
          const marks = window as unknown as Record<string, unknown>;
          return [marks.formScriptRan, marks.formClickRan, marks.formErrorRan];
        }),
      ).toEqual([undefined, undefined, undefined]);
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(replies(page).last()).toContainText("Postgres", { timeout: 60_000 });
      expect(alerts).toEqual([]);
      expect(remote).toEqual([]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "takes at most about half the chat and scrolls inside; Hide folds it to one line until Show, Alt+H too; Esc skips (#2795)",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.setViewportSize({ width: 1280, height: 480 });
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      const folded = page.getByRole("region", { name: "Questions from omp, hidden" });
      await send(page, "ask_six");
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
          .locator("[data-form-body]")
          .evaluate((body) => body.scrollHeight > body.clientHeight),
      ).toBe(true);

      // Hide folds the questions into one line; Show brings them back as they were.
      await questions.getByRole("radio", { name: "This way" }).first().click();
      await questions.getByRole("button", { name: "Hide" }).click();
      await expect(questions).toBeHidden();
      await expect(folded).toContainText("Drop sections: which way?");
      await expect(folded).toContainText("+5 more");
      await folded.getByRole("button", { name: "Show" }).click();
      await expect(questions.getByRole("radio", { name: "This way" }).first()).toBeChecked();
      // Alt+H from the message box hides them, and shows them again.
      const box = page.getByRole("textbox", { name: "Message" });
      await box.press("Alt+h");
      await expect(folded).toBeVisible();
      await box.press("Alt+h");
      await expect(questions).toBeVisible();

      // Esc skips the form, as Esc does in omp.
      await questions.getByRole("radio", { name: "That way" }).first().focus();
      await page.keyboard.press("Escape");
      await expect(questions).toBeHidden();
      await expect(folded).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "in a chat about 400 px high, as on a phone held sideways, a question's choices can still be seen (#2807)",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.setViewportSize({ width: 874, height: 402 });
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, "ask_user");
      await expect(questions).toBeVisible({ timeout: 60_000 });
      // Each choice is the element under its own middle: not cut off by the card, nor under the message box.
      for (const name of ["Postgres", "SQLite", "Other…"]) {
        const choice = questions.getByRole("radio", { name });
        await expect
          .poll(() =>
            choice.evaluate((radio) => {
              const box = radio.getBoundingClientRect();
              const top = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return top !== null && (radio === top || radio.contains(top) || top.contains(radio));
            }),
          )
          .toBe(true);
      }
      // The message box stays whole beneath.
      await expect(page.getByRole("button", { name: "Stop" })).toBeInViewport({ ratio: 1 });
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
      await expect(box).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
        timeout: 120_000,
      });
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
      for (const name of ["Hide", "Skip", "Submit"]) {
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

  realTest(
    "a question answered on one page closes on another page that shows the chat (#2809)",
    async ({ realApp }) => {
      const first = await newChat(realApp);
      await send(first, "count_reply start");
      await expect(first.getByText("count-1 start")).toBeVisible({ timeout: 60_000 });
      // Another device opens the same chat from its list.
      const second = await realApp.open({ path: "/" });
      await second
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /count_reply start/ })
        .first()
        .click();
      await expect(second.getByText("count-1 start")).toBeVisible({ timeout: 60_000 });

      await send(first, "ask_user");
      const asked = (page: Page) => page.getByRole("dialog", { name: "Questions from omp" });
      await expect(asked(first)).toBeVisible({ timeout: 60_000 });
      await expect(asked(second)).toBeVisible({ timeout: 60_000 });
      await asked(second).getByRole("radio", { name: "Postgres" }).click();
      await asked(second).getByRole("button", { name: "Submit" }).click();
      await expect(asked(second)).toBeHidden({ timeout: 30_000 });
      // The page that did not answer closes it too, and both show the answer.
      await expect(asked(first)).toBeHidden({ timeout: 10_000 });
      await expect(replies(first).last()).toContainText("Postgres", { timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a notice shows above omp's question card, never over it", async ({ realApp }) => {
    const page = await newChat(realApp);
    await send(page, "ask_user");
    const card = page.getByRole("dialog", { name: "Questions from omp" });
    await expect(card).toBeVisible({ timeout: 60_000 });
    // omp's status line while it waits: Ctrl+P with one role model says so for a moment.
    await page.getByRole("textbox", { name: "Message" }).press("Control+p");
    const notice = page.getByRole("status").filter({ hasText: "Only one role model available" });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const noticeBox = await notice.boundingBox();
    const cardBox = await card.boundingBox();
    if (noticeBox === null || cardBox === null)
      throw new Error("no box for the notice or the card");
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(cardBox.y);
    expect(realApp.problems).toEqual([]);
  });
});
