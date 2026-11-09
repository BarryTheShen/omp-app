import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Questions omp asks without waiting (the chat host's `ask_async` tool), in the new UI on real omp: omp asks and its
 * turn goes on; the chat says so and the rail's Questions button counts them; the Questions panel opens on Questions for
 * you, a card each, with the agent's context; an answer waits, changeable, for the chat's other open questions, whichever
 * ask they came from, and Send answers sends the waiting ones at once; the chat's last answer sends the rest together as
 * one message from the person, which omp answers; a skipped question sends nothing; the answers are there again
 * after a reload. `/btw` brings the side questions forward, also while questions wait.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const panel = (page: Page) =>
  page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("tabpanel", { name: "Questions" });
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
    "wait in the Questions panel while omp works on; the answers of an ask go to the chat together",
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
      // The rail's Questions button counts the questions.
      await rail(page).getByRole("button", { name: "Questions, 3 waiting for you" }).click();
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
      // Other questions of the ask are open, so the answer is saved to wait for them.
      const save = publish.getByRole("button", { name: "Save answer" });
      await expect(save).toBeDisabled();
      await publish.getByRole("radio", { name: "Public copy" }).click();
      await publish.getByRole("button", { name: "Add a note" }).click();
      await publish.getByRole("textbox", { name: "Note on your answer" }).fill("keep issues off");
      await save.click();

      // The answer waits, and nothing went to the chat yet.
      const waiting = panel(page).getByRole("article", { name: "Ready to send: Publish" });
      await expect(waiting).toContainText("Public copy");
      await expect(waiting).toContainText("Note: keep issues off");
      const bar = panel(page).getByRole("region", { name: "Answers ready to send" });
      await expect(bar).toContainText("1 answer ready.");
      await expect(
        rail(page).getByRole("button", { name: "Questions, 2 waiting for you" }),
      ).toBeVisible();
      await expect(
        transcript(page).getByText("Answer to your question", { exact: false }),
      ).toHaveCount(0);

      // Send answers sends it at once, as the person's message, and omp answers it.
      await bar.getByRole("button", { name: "Send answers" }).click();
      const answer = transcript(page).getByText('Answer to your question "Publish" (publish):', {
        exact: false,
      });
      await expect(answer).toBeVisible({ timeout: 60_000 });
      await expect(answer).toContainText("Note: keep issues off");
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });
      await expect(bar).toHaveCount(0);
      const answered = panel(page).getByRole("article", { name: "Answered: Publish" });
      await expect(answered).toContainText("Public copy");
      await expect(answered).toContainText("Note: keep issues off");

      // Several choices of a question that takes them; a waiting answer can be changed.
      const days = panel(page).getByRole("article", { name: "Question: Days" });
      await days.getByRole("checkbox", { name: "Monday" }).click();
      await days.getByRole("checkbox", { name: "Wednesday" }).click();
      await days.getByRole("button", { name: "Save answer" }).click();
      const daysWaiting = panel(page).getByRole("article", { name: "Ready to send: Days" });
      await expect(daysWaiting).toContainText("Monday, Wednesday");
      await daysWaiting.getByRole("button", { name: "Change" }).click();
      const changing = panel(page).getByRole("article", { name: "Question: Days" });
      await expect(changing.getByRole("checkbox", { name: "Wednesday" })).toBeChecked();
      await changing.getByRole("checkbox", { name: "Wednesday" }).click();
      await changing.getByRole("checkbox", { name: "Tuesday" }).click();
      await changing.getByRole("button", { name: "Save answer" }).click();
      await expect(daysWaiting).toContainText("Monday, Tuesday");

      // The ask's last question sends what waits with it, as one message: the skip sends nothing, so the Days answer
      // goes alone.
      const name = panel(page).getByRole("article", {
        name: "Question: What should the public copy be called?",
      });
      await expect(name.getByRole("textbox", { name: "Your answer" })).toBeVisible();
      await expect(name.getByRole("button", { name: "Send answers" })).toBeVisible();
      await name.getByRole("button", { name: "Skip" }).click();
      await expect(
        transcript(page).getByText('Answer to your question "Days" (days):', { exact: false }),
      ).toBeVisible({
        timeout: 60_000,
      });
      // The person's message lists the choices, as Markdown draws a list; the skipped question has no line in it (the
      // message names each question it answers as `"<question>" (<id>):`).
      await expect(
        transcript(page).getByRole("listitem").filter({ hasText: "Monday" }),
      ).toBeVisible();
      await expect(
        transcript(page).getByRole("listitem").filter({ hasText: "Tuesday" }),
      ).toBeVisible();
      await expect(transcript(page).getByText("(name):", { exact: false })).toHaveCount(0);
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(2, {
        timeout: 90_000,
      });
      await expect(panel(page).getByText("Nothing waits for you.", { exact: false })).toBeVisible();
      await expect(
        panel(page).getByRole("article", {
          name: "Answered: What should the public copy be called?",
        }),
      ).toContainText("Skipped");
      await expect(
        rail(page).getByRole("button", { name: "Questions", exact: true }),
      ).toBeVisible();

      // After a reload, the questions are there with their answers.
      await page.reload();
      await expect(box(page)).toBeVisible({ timeout: 60_000 });
      if (!(await panel(page).isVisible())) {
        await rail(page).getByRole("button", { name: "Questions", exact: true }).click();
      }
      await panel(page).getByRole("tab", { name: "Questions for you" }).click();
      await expect(panel(page).getByRole("article", { name: "Answered: Publish" })).toContainText(
        "Public copy",
      );
      await expect(panel(page).getByRole("article", { name: "Answered: Days" })).toContainText(
        "Monday, Tuesday",
      );
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "answers to separate asks wait for each other and go as one message",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      for (const [id, question, said] of [
        ["color", "Which color?", 1],
        ["size", "Which size?", 2],
      ] as const) {
        await box(page).fill(
          `call_tool ask_async ${JSON.stringify({ questions: [{ id, question }] })}`,
        );
        await box(page).press("Enter");
        await expect(
          transcript(page).getByText(`tool said: Asked 1 question (${id}).`, { exact: false }),
        ).toHaveCount(1, { timeout: 90_000 });
        await expect(
          transcript(page).getByText("tool said: Asked 1 question", { exact: false }),
        ).toHaveCount(said);
      }
      await rail(page).getByRole("button", { name: "Questions, 2 waiting for you" }).click();

      // The first ask's answer waits: the other ask's question is still open.
      const color = panel(page).getByRole("article", { name: "Question: Which color?" });
      await color.getByRole("textbox", { name: "Your answer" }).fill("Green");
      await color.getByRole("button", { name: "Save answer" }).click();
      const bar = panel(page).getByRole("region", { name: "Answers ready to send" });
      await expect(bar).toContainText("1 answer ready.");
      await expect(
        panel(page).getByRole("article", { name: "Ready to send: Which color?" }),
      ).toContainText("Green");
      await expect(
        transcript(page).getByText("Answer to your question", { exact: false }),
      ).toHaveCount(0);

      // The last open question sends both, as one message from the person.
      const size = panel(page).getByRole("article", { name: "Question: Which size?" });
      await size.getByRole("textbox", { name: "Your answer" }).fill("Large");
      await size.getByRole("button", { name: "Send answers" }).click();
      await expect(
        transcript(page).getByText("Answers to your questions:", { exact: false }),
      ).toBeVisible({ timeout: 60_000 });
      for (const block of ['"Which color?" (color):', '"Which size?" (size):']) {
        await expect(transcript(page).getByText(block, { exact: false })).toBeVisible();
      }
      await expect(
        transcript(page).getByText("Answer to your question", { exact: false }),
      ).toHaveCount(0);
      await expect(bar).toHaveCount(0);
      await expect(panel(page).getByText("Nothing waits for you.", { exact: false })).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "/btw brings the side questions forward, also while a question waits for you",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const one = { questions: [{ id: "color", question: "Which color?" }] };
      await box(page).fill(`call_tool ask_async ${JSON.stringify(one)}`);
      await box(page).press("Enter");
      await expect(
        transcript(page).getByText("tool said: Asked 1 question (color).", { exact: false }),
      ).toBeVisible({ timeout: 90_000 });
      // The panel opens on the question that waits.
      await rail(page).getByRole("button", { name: "Questions, 1 waiting for you" }).click();
      const forYou = panel(page).getByRole("tab", { name: "Questions for you 1" });
      const side = panel(page).getByRole("tab", { name: "Side questions" });
      await expect(forYou).toHaveAttribute("aria-selected", "true");

      // A side question shows on the Side questions tab, and its answer comes there.
      await box(page).fill("/btw What is this chat about?");
      await box(page).press("Enter");
      await expect(side).toHaveAttribute("aria-selected", "true");
      await expect(
        panel(page)
          .getByRole("region", { name: "Side question" })
          .getByRole("article", { name: "Question" }),
      ).toContainText("pong", { timeout: 60_000 });

      // After a look at the question, `/btw` alone opens the side questions again; the question still waits.
      await forYou.click();
      await expect(
        panel(page).getByRole("article", { name: "Question: Which color?" }),
      ).toBeVisible();
      await box(page).fill("/btw");
      await box(page).press("Enter");
      await expect(box(page)).toHaveValue("/btw ");
      await box(page).press("Enter");
      await expect(side).toHaveAttribute("aria-selected", "true");
      await expect(
        rail(page).getByRole("button", { name: "Questions, 1 waiting for you" }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );
});
