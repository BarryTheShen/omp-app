import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * What waits for your answer, in the new UI on real omp: omp's own question that stops a chat waits at the top of that
 * chat's Workbench too, answered there; the Questions panel holds only the side questions (`/btw`); and in the lite
 * view, which has no side panel, the questions of the chat's threads show above its message box and are answered there,
 * reaching the chat from the thread.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const side = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Side panel" }).getByRole("tabpanel", { name });
const rail = (page: Page) => page.getByRole("navigation", { name: "Side panel" });

realTest.describe("questions that wait for you", () => {
  realTest.setTimeout(240_000);

  realTest(
    "omp's question that stops the chat waits at the top of its Workbench too; answered there, the chat's card closes and omp goes on",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("ask_user");
      await box(page).press("Enter");
      const inChat = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(inChat).toBeVisible({ timeout: 60_000 });
      await rail(page).getByRole("button", { name: "Workbench, 1 waiting for you" }).click();
      const listed = side(page, "Workbench")
        .getByRole("region", { name: "The chat waits for you" })
        .getByRole("region", { name: "Questions from omp" });
      await listed.getByRole("radio", { name: "Postgres" }).click();
      await listed.getByRole("button", { name: "Submit" }).click();
      await expect(inChat).toHaveCount(0);
      await expect(listed).toHaveCount(0);
      await expect(page.getByText(/^tool said: /).last()).toContainText("Postgres", {
        timeout: 60_000,
      });
      await expect(
        rail(page).getByRole("button", { name: "Workbench", exact: true }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the Questions panel holds the side questions alone: omp's question waiting is not in it, and it has no tabs",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("ask_user");
      await box(page).press("Enter");
      await expect(page.getByRole("dialog", { name: "Questions from omp" })).toBeVisible({
        timeout: 60_000,
      });
      // The Questions button counts nothing: what stops the chat is counted on Workbench's.
      await expect(
        rail(page).getByRole("button", { name: "Questions", exact: true }),
      ).toBeVisible();
      await rail(page).getByRole("button", { name: "Questions", exact: true }).click();
      const panel = side(page, "Questions");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("tab")).toHaveCount(0);
      await expect(panel.getByRole("region", { name: "Questions from omp" })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "in the lite view, the questions of the chat's threads show above the message box: folded to one line, over the whole chat, and answered there",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await expect(box(page)).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
        timeout: 120_000,
      });
      await box(page).fill(
        'call_tool thread_open {"title":"Notes store","kind":"question","text":"Which database"}',
      );
      await box(page).press("Enter");
      const opened = transcript(page).getByText(/tool said: Opened thread [a-z0-9]+/);
      await expect(opened).toBeVisible({ timeout: 90_000 });
      const id = /Opened thread ([a-z0-9]+)/.exec((await opened.textContent()) ?? "")?.[1] ?? "";
      const one = {
        id,
        questions: [
          {
            id: "store",
            question: "Which database should the notes use?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            recommended: 1,
          },
        ],
      };
      await box(page).fill(`call_tool thread_ask ${JSON.stringify(one)}`);
      await box(page).press("Enter");
      const card = page.getByRole("region", { name: "Questions from omp", exact: true });
      await expect(card).toContainText("1 question waits for you", { timeout: 90_000 });
      await expect(card).toContainText("Which database should the notes use?");

      // Folded to one line, and shown again.
      await card.getByRole("button", { name: "Fold the questions" }).click();
      await expect(card).toHaveCount(0);
      const folded = page.getByRole("region", { name: "Questions from omp, folded" });
      await expect(folded).toContainText("1 question waits for you");
      await folded.getByRole("button", { name: "Show" }).click();
      await expect(card).toBeVisible();

      // Over the whole chat: the card covers the transcript from the top; back above the message box.
      await card.getByRole("button", { name: "Show the questions over the chat" }).click();
      const height = page.viewportSize()?.height ?? 0;
      await expect
        .poll(async () => {
          const over = await card.boundingBox();
          return over !== null && over.y < 120 && over.height > height * 0.6;
        })
        .toBe(true);
      await card.getByRole("button", { name: "Show the questions above the message box" }).click();
      await expect.poll(async () => (await card.boundingBox())?.y ?? 0).toBeGreaterThan(120);

      // Answered here: the recommended choice is picked, and the answer reaches the chat from the thread.
      await expect(card.getByRole("radio", { name: "SQLite" })).toBeChecked();
      await card.getByRole("button", { name: "Send answers" }).click();
      await expect(transcript(page)).toContainText(
        `Thread ${id} "Notes store": the person's answer to your question:`,
        { timeout: 60_000 },
      );
      await expect(transcript(page)).toContainText("SQLite");
      await expect(card).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
