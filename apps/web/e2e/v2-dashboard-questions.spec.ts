import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Every chat's questions on the dashboard (D7) on real omp: a chat's agent asks without waiting (`ask_async`); the
 * dashboard lists the asks under the chat's name, a card each, answered there as in the chat: an ask's answers wait for
 * the chat's other open ask and leave the open ones, the last ask sends both to the chat as the person's message, and
 * the chat leaves the list.
 */
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const questions = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "Questions", exact: true });

const DATABASE = {
  questions: [
    {
      id: "db",
      header: "Database",
      question: "Which database should the app use?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};
const NAME = {
  questions: [{ id: "name", header: "Name", question: "What should the service be called?" }],
};

realTest.describe("new UI: every chat's questions on the dashboard", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a chat's questions wait on the dashboard under its name; answered there, they go to the chat together and leave",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      for (const [ask, said] of [
        [DATABASE, "tool said: Asked 1 question (db)."],
        [NAME, "tool said: Asked 1 question (name)."],
      ] as const) {
        await box(page).fill(`call_tool ask_async ${JSON.stringify(ask)}`);
        await box(page).press("Enter");
        await expect(transcript(page).getByText(said, { exact: false })).toBeVisible({
          timeout: 90_000,
        });
      }

      // The dashboard's button counts what waits there: both questions.
      const button = page.getByRole("button", { name: /^Dashboard(,|$)/ });
      await expect(button).toHaveAccessibleName("Dashboard, 2 waiting for you", {
        timeout: 30_000,
      });
      await button.click();
      const list = questions(page);
      const chat = list.getByRole("region", { name: /^Questions from / });
      await expect(chat).toHaveCount(1, { timeout: 30_000 });
      const database = chat.getByRole("article", { name: "Question: Database" });
      await expect(database).toContainText("Which database should the app use?");

      // The first ask's answer waits for the chat's other open ask, and leaves the open ones.
      await database.getByRole("radio", { name: "Postgres" }).click();
      await database.getByRole("button", { name: "Save answer" }).click();
      await expect(chat.getByRole("article", { name: "Question: Database" })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(button).toHaveAccessibleName("Dashboard, 1 waiting for you");
      await expect(chat.getByRole("article", { name: "Ready to send: Database" })).toContainText(
        "Postgres",
      );

      // The last ask sends both, as the person's message; the chat leaves the list.
      const name = chat.getByRole("article", { name: "Question: Name" });
      await name.getByRole("textbox", { name: "Your answer" }).fill("atlas");
      await name.getByRole("button", { name: "Send answers" }).click();
      await expect(list).toContainText("No question waits for you.", { timeout: 60_000 });
      await expect(button).toHaveAccessibleName("Dashboard");

      await page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab").first().click();
      const answers = transcript(page).getByText("Answers to your questions", { exact: false });
      await expect(answers).toBeVisible({ timeout: 60_000 });
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
