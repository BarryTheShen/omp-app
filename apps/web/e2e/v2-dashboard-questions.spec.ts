import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Every chat's questions on the dashboard (D7) on real omp: a chat's agent asks without waiting (`ask_async`); the
 * dashboard lists the questions under the chat's name, answered there as in the chat: an answer waits for the chat's
 * other question and leaves the open ones, the last answer sends both to the chat as the person's message, and the
 * chat leaves the list.
 */
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const questions = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "Questions", exact: true });

const ASK = {
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

realTest.describe("new UI: every chat's questions on the dashboard", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a chat's questions wait on the dashboard under its name; answered there, they go to the chat together and leave",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill(`call_tool ask_async ${JSON.stringify(ASK)}`);
      await box(page).press("Enter");
      await expect(
        transcript(page).getByText("tool said: Asked 2 questions", { exact: false }),
      ).toBeVisible({ timeout: 90_000 });

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

      // The first answer waits for the chat's other question, and leaves the open ones.
      await database.getByRole("radio", { name: "Postgres" }).click();
      await database.getByRole("button", { name: "Save answer" }).click();
      await expect(chat.getByRole("article", { name: "Question: Database" })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(button).toHaveAccessibleName("Dashboard, 1 waiting for you");
      await expect(chat.getByRole("article", { name: "Ready to send: Database" })).toContainText(
        "Postgres",
      );

      // The last one sends both, as the person's message; the chat leaves the list.
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
});
