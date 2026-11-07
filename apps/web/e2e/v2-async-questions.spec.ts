import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Questions omp asks without waiting (the chat host's `ask_async` tool), in the new UI on real omp: omp asks and its
 * turn goes on; the chat says so and the rail's BTW button counts them; the BTW panel opens on Questions for you, a card
 * each, with the agent's context; an answer goes into the chat as the person's message and omp answers it; a skipped
 * question tells omp to decide; the answers are there again after a reload.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const panel = (page: Page) =>
  page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("tabpanel", { name: "BTW history" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Side panel" });

const ASK = {
  questions: [
    {
      id: "publish",
      header: "Publish",
      question: "How should the project be published?",
      context: "Issues on a public repository can be opened by **anyone**.",
      options: [
        { label: "Public copy", description: "A new repository with the code only" },
        { label: "This repository" },
      ],
      recommended: 0,
    },
    {
      id: "days",
      header: "Days",
      question: "Which days can the release run?",
      options: [{ label: "Monday" }, { label: "Tuesday" }, { label: "Wednesday" }],
      multi: true,
    },
    { id: "name", question: "What should the public copy be called?" },
  ],
};

realTest.describe("questions omp asks without waiting", () => {
  realTest.setTimeout(240_000);

  realTest(
    "wait in the BTW panel while omp works on; each answer goes to the chat as the person's message",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill(`call_tool ask_async ${JSON.stringify(ASK)}`);
      await box(page).press("Enter");

      // The chat says omp asked, while omp goes on: its turn ends with the tool's answer.
      await expect(page.getByText("omp asked you a question.", { exact: false })).toBeVisible({
        timeout: 90_000,
      });
      await expect(
        transcript(page).getByText("tool said: Asked 3 questions", { exact: false }),
      ).toBeVisible({ timeout: 90_000 });
      // The rail's BTW button counts the questions.
      await rail(page).getByRole("button", { name: "BTW history, 3 questions for you" }).click();
      await expect(panel(page).getByRole("tab", { name: "Questions for you 3" })).toHaveAttribute(
        "aria-selected",
        "true",
      );

      // A card per question, with the agent's context and its recommendation.
      const publish = panel(page).getByRole("article", { name: "Question: Publish" });
      await expect(publish).toContainText("How should the project be published?");
      await expect(publish.getByRole("region", { name: "Context" })).toContainText(
        "Issues on a public repository can be opened by anyone.",
      );
      await expect(publish.getByText("Recommended")).toBeVisible();
      await expect(publish).toContainText("A new repository with the code only");
      const send = publish.getByRole("button", { name: "Send answer" });
      await expect(send).toBeDisabled();
      await publish.getByRole("radio", { name: "Public copy" }).click();
      await publish.getByRole("button", { name: "Add a note" }).click();
      await publish.getByRole("textbox", { name: "Note on your answer" }).fill("keep issues off");
      await send.click();

      // The answer is the person's message in the chat, and omp answers it.
      const answer = transcript(page).getByText('Answer to your question "Publish" (publish):', {
        exact: false,
      });
      await expect(answer).toBeVisible({ timeout: 60_000 });
      await expect(answer).toContainText("Note: keep issues off");
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });
      // The card folds to its answer, and the counts go down.
      const answered = panel(page).getByRole("article", { name: "Answered: Publish" });
      await expect(answered).toContainText("Public copy");
      await expect(answered).toContainText("Note: keep issues off");
      await expect(
        rail(page).getByRole("button", { name: "BTW history, 2 questions for you" }),
      ).toBeVisible();

      // Several choices of a question that takes them.
      const days = panel(page).getByRole("article", { name: "Question: Days" });
      await days.getByRole("checkbox", { name: "Monday" }).click();
      await days.getByRole("checkbox", { name: "Wednesday" }).click();
      await days.getByRole("button", { name: "Send answer" }).click();
      // The person's message lists the choices, as Markdown draws a list.
      await expect(
        transcript(page).getByText('Answer to your question "Days" (days):', { exact: false }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        transcript(page).getByRole("listitem").filter({ hasText: "Monday" }),
      ).toBeVisible();
      await expect(
        transcript(page).getByRole("listitem").filter({ hasText: "Wednesday" }),
      ).toBeVisible();
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(2, {
        timeout: 90_000,
      });

      // A question without choices takes a written answer, or a skip: omp is told to decide.
      const name = panel(page).getByRole("article", {
        name: "Question: What should the public copy be called?",
      });
      await expect(name.getByRole("textbox", { name: "Your answer" })).toBeVisible();
      await name.getByRole("button", { name: "Skip" }).click();
      await expect(
        transcript(page).getByText(
          'Skipped your question "What should the public copy be called?" (name): decide it yourself.',
        ),
      ).toBeVisible({ timeout: 60_000 });
      await expect(panel(page).getByText("Nothing waits for you.", { exact: false })).toBeVisible();
      await expect(
        panel(page).getByRole("article", {
          name: "Answered: What should the public copy be called?",
        }),
      ).toContainText("Skipped");
      await expect(
        rail(page).getByRole("button", { name: "BTW history", exact: true }),
      ).toBeVisible();

      // After a reload, the questions are there with their answers.
      await page.reload();
      await expect(box(page)).toBeVisible({ timeout: 60_000 });
      if (!(await panel(page).isVisible())) {
        await rail(page).getByRole("button", { name: "BTW history", exact: true }).click();
      }
      await panel(page).getByRole("tab", { name: "Questions for you" }).click();
      await expect(panel(page).getByRole("article", { name: "Answered: Publish" })).toContainText(
        "Public copy",
      );
      await expect(panel(page).getByRole("article", { name: "Answered: Days" })).toContainText(
        "Monday, Wednesday",
      );
      expect(realApp.problems).toEqual([]);
    },
  );
});
