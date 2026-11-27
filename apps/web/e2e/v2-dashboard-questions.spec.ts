import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/**
 * What waits for you on the dashboard (D7) on real omp: a chat asks in a Workbench thread (`thread_ask`); the dashboard
 * counts the thread, and its Workbench lists every chat's threads under the chat's name, the thread picked shown beside
 * the list, its questions answered there; the answers reach the chat from the thread. omp's own question that stops a
 * chat waits in the dashboard's Questions, under the chat's name.
 */
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const questions = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "Questions", exact: true });
const workbench = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "Workbench", exact: true });

realTest.describe("new UI: every chat's questions on the dashboard", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a thread waits in the dashboard's Workbench under its chat; picked there, its questions are answered beside the list and reach the chat",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill(
        'call_tool thread_open {"title":"Service setup","kind":"task","text":"Set up the service"}',
      );
      await box(page).press("Enter");
      const opened = transcript(page).getByText(/tool said: Opened thread [a-z0-9]+/);
      await expect(opened).toBeVisible({ timeout: 90_000 });
      const id = /Opened thread ([a-z0-9]+)/.exec((await opened.textContent()) ?? "")?.[1] ?? "";
      const ask = {
        id,
        questions: [
          {
            id: "db",
            header: "Database",
            question: "Which database should the app use?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
          { id: "name", header: "Name", question: "What should the service be called?" },
        ],
      };
      await box(page).fill(`call_tool thread_ask ${JSON.stringify(ask)}`);
      await box(page).press("Enter");
      await expect(transcript(page).getByText(/tool said: Asked in thread/)).toBeVisible({
        timeout: 90_000,
      });

      // The dashboard's button counts what waits there: the thread.
      const button = page.getByRole("button", { name: /^Dashboard(,|$)/ });
      await expect(button).toHaveAccessibleName("Dashboard, 1 waiting for you", {
        timeout: 30_000,
      });
      await button.click();
      const board = workbench(page);
      // Under its chat's name (the chat is named by its first message).
      const group = board.getByRole("region", { name: /^Threads of call_tool thread_open/ });
      await group
        .getByRole("button", { name: /^Service setup, Open, 2 questions for you/ })
        .click();
      const thread = board.getByRole("region", { name: "Thread: Service setup" });
      const card = thread.getByRole("region", { name: "Questions: Database, Name" });
      await expect(card).toContainText("Which database should the app use?", { timeout: 30_000 });
      await board.scrollIntoViewIfNeeded();
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "dashboard-workbench.png") });
      await card.getByRole("radio", { name: "Postgres" }).click();
      await card.getByRole("textbox", { name: "Your answer" }).fill("atlas");
      await card.getByRole("button", { name: "Send answers" }).click();
      await expect(thread.getByRole("region", { name: "Answered questions" })).toContainText(
        "Database: Postgres",
        { timeout: 60_000 },
      );
      await expect(button).toHaveAccessibleName("Dashboard");

      await page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab").first().click();
      await expect(transcript(page)).toContainText(
        `Thread ${id} "Service setup": the person's answers to your questions:`,
        { timeout: 60_000 },
      );
      await expect(transcript(page)).toContainText("Postgres");
      await expect(transcript(page)).toContainText("atlas");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "omp's question that stops a chat waits on the dashboard too, under the chat's name; answered there, the chat goes on",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("ask_user");
      await box(page).press("Enter");
      const inChat = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(inChat).toBeVisible({ timeout: 60_000 });

      const button = page.getByRole("button", { name: /^Dashboard(,|$)/ });
      await expect(button).toHaveAccessibleName("Dashboard, 1 waiting for you", {
        timeout: 30_000,
      });
      await button.click();
      // The chat's section ("Questions from <its name>"), not omp's card in it ("Questions from omp").
      const chat = questions(page).getByRole("region", { name: /^Questions from (?!omp$)/ });
      await expect(chat).toHaveCount(1, { timeout: 30_000 });
      const card = chat.getByRole("region", { name: "Questions from omp" });
      await card.getByRole("radio", { name: "Postgres" }).click();
      await card.getByRole("button", { name: "Submit" }).click();
      await expect(chat).toHaveCount(0, { timeout: 30_000 });
      await expect(button).toHaveAccessibleName("Dashboard", { timeout: 30_000 });
      // The chat's own card closed with it, and omp took the answer.
      await expect(inChat).toHaveCount(0);
      await expect(page.getByText(/^tool said: /).last()).toContainText("Postgres", {
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );
});
