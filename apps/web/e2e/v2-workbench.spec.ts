import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/**
 * Workbench (threads, one per piece of work) in the new UI on real omp: the agent opens a thread and asks in it with
 * its `thread_*` tools; the rail counts what waits on you; the panel lists the thread under Open; you answer in the
 * thread and the chat gets the answers as a notice from Workbench. A thread you open goes to the chat you pick, as a
 * notice, and what you write in it too; another page follows it live.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Side panel" });
const workbench = (page: Page) =>
  page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("tabpanel", { name: "Workbench" });

async function send(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await box(page).press("Enter");
}

realTest.describe("Workbench", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the agent opens a thread and asks in it; you answer in Workbench, and the chat gets the answers from the thread",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await send(
        page,
        'call_tool thread_open {"title":"Slow new chat","kind":"bug","text":"It takes **30 s** to list"}',
      );
      const opened = transcript(page).getByText(/tool said: Opened thread [a-z0-9]+/);
      await expect(opened).toBeVisible({ timeout: 90_000 });
      const id = /Opened thread ([a-z0-9]+)/.exec((await opened.textContent()) ?? "")?.[1] ?? "";
      expect(id).not.toBe("");
      await send(
        page,
        `call_tool thread_ask ${JSON.stringify({
          id,
          questions: [
            {
              id: "order",
              header: "Order",
              question: "Build it before or after?",
              options: [{ label: "Before" }, { label: "After" }],
              recommended: 1,
            },
            { id: "change", question: "Anything to change?" },
          ],
        })}`,
      );
      await expect(transcript(page).getByText(/tool said: Asked in thread/)).toBeVisible({
        timeout: 90_000,
      });

      // The rail counts the thread that waits on you; the panel opens on Open, which counts it.
      await rail(page).getByRole("button", { name: "Workbench, 1 waiting for you" }).click();
      const panel = workbench(page);
      await expect(panel.getByRole("tab", { name: "Open 1" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await panel.getByRole("button", { name: "Slow new chat, Open, 2 questions for you" }).click();
      const thread = panel.getByRole("region", { name: "Thread: Slow new chat" });
      await expect(thread.getByRole("list", { name: "Timeline" })).toContainText(
        "It takes 30 s to list",
      );

      const card = thread.getByRole("region", { name: "Questions: Order, Anything to change?" });
      await expect(card.getByRole("radio", { name: "After" })).toBeChecked();
      const sendAnswers = card.getByRole("button", { name: "Send the 1 ready" });
      await expect(sendAnswers).toBeEnabled();
      await card.getByRole("textbox", { name: "Your answer" }).fill("Keep it small");
      // Half an answer is kept: going back to the list and opening the thread again finds it.
      await thread.getByRole("button", { name: "Threads" }).click();
      await panel.getByRole("button", { name: /^Slow new chat, Open/ }).click();
      await expect(card.getByRole("textbox", { name: "Your answer" })).toHaveValue("Keep it small");
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "workbench-ask-dark.png") });
      await card.getByRole("button", { name: "Send answers" }).click();

      // The chat gets both answers together, as a notice from Workbench, never as the person's message.
      await expect(transcript(page).getByText("From Workbench")).toBeVisible({ timeout: 60_000 });
      await expect(transcript(page)).toContainText(
        `Thread ${id} "Slow new chat": the person's answers to your questions:`,
      );
      await expect(transcript(page)).toContainText("Keep it small");
      await expect(thread.getByRole("region", { name: "Answered questions" })).toContainText(
        "Order: After",
      );
      // The answers show in their card; the timeline holds the thread's opening and its ask, no empty rows.
      await expect(
        thread.getByRole("list", { name: "Timeline" }).getByRole("listitem"),
      ).toHaveCount(2);
      await expect(
        rail(page).getByRole("button", { name: "Workbench", exact: true }),
      ).toBeVisible();

      await page
        .getByRole("group", { name: "Theme" })
        .getByRole("button", { name: "Light" })
        .click();
      await page.screenshot({ path: join(screenshots, "workbench-answered-light.png") });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a thread you open is this chat's: the chat gets it as a notice, another page in the chat follows it live, and another chat's Workbench has its own list",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await send(page, "hello");
      await expect(transcript(page).getByText("pong")).toBeVisible({ timeout: 90_000 });

      await rail(page).getByRole("button", { name: "Workbench", exact: true }).click();
      const panel = workbench(page);
      await expect(panel).toContainText("No open threads.");
      await panel.getByRole("button", { name: "New thread" }).click();
      const form = panel.getByRole("region", { name: "New thread" });
      await form.getByRole("textbox", { name: "Title" }).fill("Relay test");
      await form.getByRole("radio", { name: "Feature" }).click();
      await form
        .getByRole("textbox", { name: "Details (optional)" })
        .fill("Drive the laptop's browser");
      await expect(form.getByRole("radiogroup", { name: "It goes to" })).toHaveCount(0);
      await form.getByRole("button", { name: "Open the thread" }).click();
      const thread = panel.getByRole("region", { name: "Thread: Relay test" });
      await expect(thread).toBeVisible();
      await expect(transcript(page).getByText("From Workbench")).toBeVisible({ timeout: 60_000 });
      await expect(transcript(page)).toContainText(
        '"Relay test" (feature), opened by the person for this chat:',
      );

      // Another page, in the same chat: its Workbench shows the thread.
      const other = await realApp.open({ path: "/" });
      await other
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /^hello/ })
        .click();
      // The chat answered twice by now (hello, then the thread's notice): its transcript has a pong.
      await expect(transcript(other).getByText("pong").first()).toBeVisible({ timeout: 60_000 });
      await rail(other).getByRole("button", { name: "Workbench", exact: true }).click();
      const otherPanel = workbench(other);
      await otherPanel.getByRole("button", { name: "Relay test, Open" }).click();
      const otherThread = otherPanel.getByRole("region", { name: "Thread: Relay test" });
      await expect(otherThread.getByRole("list", { name: "Timeline" })).toContainText(
        "Drive the laptop's browser",
      );

      await thread.getByRole("textbox", { name: "Write in the thread" }).fill("Any news?");
      await thread.getByRole("button", { name: "Send" }).click();
      await expect(otherThread.getByRole("list", { name: "Timeline" })).toContainText("Any news?", {
        timeout: 10_000,
      });
      await expect(transcript(page)).toContainText('"Relay test": the person wrote:', {
        timeout: 60_000,
      });
      await otherThread.getByRole("combobox", { name: "State" }).selectOption("done");
      await expect(thread.getByRole("combobox", { name: "State" })).toHaveValue("done", {
        timeout: 10_000,
      });

      // Another chat has a Workbench of its own: this chat's thread is not in it.
      await startNewChat(page);
      // New chat puts the caret in the new chat's message box (the first chat's may sit beside it).
      const secondBox = page.getByRole("textbox", { name: "Message" }).and(page.locator(":focus"));
      await expect(secondBox).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await secondBox.fill("second chat");
      await secondBox.press("Enter");
      // The panel is still open and follows the chat you are in: once the new chat has its id, its own list shows.
      const secondPanel = workbench(page);
      await expect(secondPanel.getByRole("tab", { name: "Open 0" })).toBeVisible({
        timeout: 90_000,
      });
      await expect(secondPanel).toContainText("No open threads.");
      await secondPanel.getByRole("tab", { name: "Closed 0" }).click();
      await expect(secondPanel).toContainText("No closed threads.");
      await expect(secondPanel.getByRole("button", { name: /^Relay test/ })).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the Workbench's message box opens a thread from what you type, and keeps what you typed until it is sent",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await send(page, "hello");
      await expect(transcript(page).getByText("pong")).toBeVisible({ timeout: 90_000 });

      await rail(page).getByRole("button", { name: "Workbench", exact: true }).click();
      const panel = workbench(page);
      const message = panel.getByRole("textbox", { name: "Message the Workbench" });
      await message.fill("When is the job app done?");
      // Kept: the box leaves (New thread, then Cancel) and comes back holding it.
      await panel.getByRole("button", { name: "New thread" }).click();
      await panel.getByRole("button", { name: "Cancel" }).click();
      await expect(message).toHaveValue("When is the job app done?");

      await message.press("Enter");
      const thread = panel.getByRole("region", { name: "Thread: When is the job app done?" });
      await expect(thread).toBeVisible();
      await expect(transcript(page)).toContainText(
        '"When is the job app done?" (question), opened by the person for this chat; the title is the whole message',
        { timeout: 60_000 },
      );
      await thread.getByRole("button", { name: "Threads" }).click();
      await expect(message).toHaveValue("");
      await expect(
        panel.getByRole("button", { name: /^When is the job app done\?, Open/ }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );
});
