import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * What waits for you on the dashboard (D7) on real omp: a chat asks in a Workbench thread (`thread_ask`); the dashboard
 * counts the thread and lists its open questions under "Threads waiting on you", answered there as in Workbench, and
 * the answers reach the chat from the thread. omp's own question that stops a chat waits there too, under its name.
 */
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const questions = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "Questions", exact: true });

realTest.describe("new UI: every chat's questions on the dashboard", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a thread's questions wait on the dashboard; answered there, they reach the chat from the thread and leave",
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
      const list = questions(page);
      const thread = list
        .getByRole("region", { name: "Threads waiting on you" })
        .getByRole("region", { name: "Thread: Service setup" });
      const card = thread.getByRole("region", { name: "Questions: Database, Name" });
      await expect(card).toContainText("Which database should the app use?", { timeout: 30_000 });
      await card.getByRole("radio", { name: "Postgres" }).click();
      await card.getByRole("textbox", { name: "Your answer" }).fill("atlas");
      await card.getByRole("button", { name: "Send answers" }).click();
      await expect(list).toContainText("No question waits for you.", { timeout: 60_000 });
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
