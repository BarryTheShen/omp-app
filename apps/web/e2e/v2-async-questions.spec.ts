import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Questions omp asks without waiting (the chat host's `ask_async` tool), in the new UI on real omp: omp asks and its
 * turn goes on; the chat says so and the rail's Questions button counts them; the Questions panel opens on Questions for
 * you, one card per ask with its questions in the order asked, the agent's context and the recommended choice already
 * picked; Skip on each question; the card's answers wait, changeable, for the chat's other open asks, and Send answers
 * sends the waiting ones at once; the chat's last ask sends the rest together as one message from the person, which omp
 * answers; a skipped question sends nothing; the answers are there again after a reload. `/btw` brings the side
 * questions forward, also while questions wait.
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
    "wait in the Questions panel while omp works on; an ask is one card, its recommended choice already picked, and its answers go to the chat together",
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

      // One card for the ask, its questions in the order asked, with the agent's context and its recommendation.
      const card = panel(page).getByRole("article", {
        name: "Questions: Publish, Days, What should the public copy be called?",
      });
      await expect(card.getByRole("region", { name: /^Question: / })).toHaveCount(3);
      const publish = card.getByRole("region", { name: "Question: Publish" });
      await expect(publish).toContainText("How should the project be published?");
      await expect(publish.getByRole("region", { name: "Context" })).toContainText(
        "Issues on a public repository can be opened by anyone.",
      );
      await expect(publish.getByText("Recommended")).toBeVisible();
      await expect(publish).toContainText("A new repository with the code only");
      // The recommended choice is already picked; the card's one button waits for an answer or a skip on each question.
      await expect(publish.getByRole("radio", { name: "Public copy" })).toBeChecked();
      const send = card.getByRole("button", { name: "Send answers" });
      await expect(send).toBeDisabled();
      await publish.getByRole("button", { name: "Add a note" }).click();
      await publish.getByRole("textbox", { name: "Note on your answer" }).fill("keep issues off");
      const days = card.getByRole("region", { name: "Question: Days" });
      await days.getByRole("checkbox", { name: "Monday" }).click();
      await days.getByRole("checkbox", { name: "Wednesday" }).click();
      await expect(send).toBeDisabled();
      const name = card.getByRole("region", {
        name: "Question: What should the public copy be called?",
      });
      await expect(name.getByRole("textbox", { name: "Your answer" })).toBeVisible();
      await name.getByRole("button", { name: "Skip" }).click();
      await expect(name).toContainText("Skipped: nothing goes to omp for it.");
      await expect(
        transcript(page).getByText("Answers to your questions", { exact: false }),
      ).toHaveCount(0);

      // One message from the person: the recommended choice as it was left, its note and the days; the skipped
      // question has no line in it (the message names each question it answers as `"<question>" (<id>):`).
      await send.click();
      const message = transcript(page)
        .locator(".tl-item")
        .filter({ hasText: "Answers to your questions:" });
      await expect(message).toHaveCount(1, { timeout: 60_000 });
      await expect(message).toContainText('"Publish" (publish):');
      await expect(message).toContainText("Public copy");
      await expect(message).toContainText("Note: keep issues off");
      await expect(message.getByRole("listitem").filter({ hasText: "Monday" })).toBeVisible();
      await expect(message.getByRole("listitem").filter({ hasText: "Wednesday" })).toBeVisible();
      await expect(message).not.toContainText("(name):");
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });
      await expect(panel(page).getByText("Nothing waits for you.", { exact: false })).toBeVisible();
      const answered = panel(page).getByRole("article", {
        name: "Answered: Publish, Days, What should the public copy be called?",
      });
      await expect(answered).toContainText("Public copy");
      await expect(answered).toContainText("Note: keep issues off");
      await expect(answered).toContainText("Monday, Wednesday");
      await expect(answered).toContainText("Skipped");
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
      const again = panel(page).getByRole("article", {
        name: "Answered: Publish, Days, What should the public copy be called?",
      });
      await expect(again).toContainText("Public copy");
      await expect(again).toContainText("Monday, Wednesday");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "answers to separate asks wait for each other and can be changed; Send answers sends what waits, the last ask the rest as one message",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      for (const [id, question, said] of [
        ["color", "Which color?", 1],
        ["size", "Which size?", 2],
        ["shape", "Which shape?", 3],
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
      await rail(page).getByRole("button", { name: "Questions, 3 waiting for you" }).click();

      // The first ask's answer waits: the other asks' questions are still open. A waiting answer can be changed.
      const color = panel(page).getByRole("article", { name: "Question: Which color?" });
      await color.getByRole("textbox", { name: "Your answer" }).fill("Green");
      await color.getByRole("button", { name: "Save answer" }).click();
      const bar = panel(page).getByRole("region", { name: "Answers ready to send" });
      await expect(bar).toContainText("1 answer ready.");
      const waiting = panel(page).getByRole("article", { name: "Ready to send: Which color?" });
      await expect(waiting).toContainText("Green");
      await waiting.getByRole("button", { name: "Change" }).click();
      const changing = panel(page).getByRole("article", { name: "Question: Which color?" });
      await expect(changing.getByRole("textbox", { name: "Your answer" })).toHaveValue("Green");
      await changing.getByRole("textbox", { name: "Your answer" }).fill("Dark green");
      await changing.getByRole("button", { name: "Save answer" }).click();
      await expect(waiting).toContainText("Dark green");
      await expect(
        transcript(page).getByText("Answer to your question", { exact: false }),
      ).toHaveCount(0);

      // Send answers sends what waits at once, as the person's message, and omp answers it.
      await bar.getByRole("button", { name: "Send answers" }).click();
      await expect(
        transcript(page).getByText('Answer to your question "Which color?" (color):', {
          exact: false,
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });
      await expect(bar).toHaveCount(0);
      await expect(
        panel(page).getByRole("article", { name: "Answered: Which color?" }),
      ).toContainText("Dark green");

      // The next ask's answer waits for the last; the last ask sends both, as one message from the person.
      const size = panel(page).getByRole("article", { name: "Question: Which size?" });
      await size.getByRole("textbox", { name: "Your answer" }).fill("Large");
      await size.getByRole("button", { name: "Save answer" }).click();
      const shape = panel(page).getByRole("article", { name: "Question: Which shape?" });
      await shape.getByRole("textbox", { name: "Your answer" }).fill("Round");
      await shape.getByRole("button", { name: "Send answers" }).click();
      await expect(
        transcript(page).getByText("Answers to your questions:", { exact: false }),
      ).toBeVisible({ timeout: 60_000 });
      for (const block of ['"Which size?" (size):', '"Which shape?" (shape):']) {
        await expect(transcript(page).getByText(block, { exact: false })).toBeVisible();
      }
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

  realTest(
    "your own answer to a question with choices takes several lines: it wraps, Shift+Enter starts a line, Enter sends",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const one = {
        questions: [
          {
            id: "colour",
            header: "Colour",
            question: "Which colour for the theme?",
            options: [{ label: "Blue" }, { label: "Green" }],
          },
        ],
      };
      await box(page).fill(`call_tool ask_async ${JSON.stringify(one)}`);
      await box(page).press("Enter");
      await rail(page)
        .getByRole("button", { name: "Questions, 1 waiting for you" })
        .click({ timeout: 90_000 });
      const card = panel(page).getByRole("article", { name: "Question: Colour" });
      await card.getByRole("radio", { name: "Other…" }).click();
      const own = card.getByRole("textbox", {
        name: "Your own answer: Which colour for the theme?",
      });
      await own.click();
      const first = "A warm red,";
      const second =
        "close to the logo's colour but a little darker, so that the text on it stays easy to read in both themes";
      await page.keyboard.type(first);
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(second);
      await expect(own).toHaveValue(`${first}\n${second}`);
      // The long line wraps inside the box, and the box shows the whole answer: nothing to scroll, either way.
      const fits = await own.evaluate((field) => ({
        sideways: field.scrollWidth - field.clientWidth,
        hidden: field.scrollHeight - field.clientHeight,
      }));
      expect(fits.sideways).toBeLessThanOrEqual(1);
      expect(fits.hidden).toBeLessThanOrEqual(1);

      // Enter sends it, both lines, as the person's message.
      await page.keyboard.press("Enter");
      const answer = transcript(page).getByText('Answer to your question "Colour" (colour):', {
        exact: false,
      });
      await expect(answer).toBeVisible({ timeout: 60_000 });
      await expect(answer).toContainText(first);
      await expect(answer).toContainText(second);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a long question shows its start and Read all, which opens the same card wide with its answer kept; on a phone it fills the screen",
    async ({ realApp, browser }) => {
      const long = (id: string) => ({
        questions: [
          {
            id,
            header: "Plan",
            question: [
              "Here is the plan.",
              "",
              "| Step | What | When |",
              "|---|---|---|",
              ...Array.from(
                { length: 8 },
                (_, at) => `| ${at + 1} | Part ${at + 1} of the work | Day ${at + 1} |`,
              ),
              "",
              ...Array.from({ length: 14 }, (_, at) => `Paragraph ${at + 1} of the plan's notes.`),
            ].join("\n"),
            options: [{ label: "Approve" }, { label: "Not yet" }],
            recommended: 0,
          },
        ],
      });

      // A computer: the card shows the start and Read all; the wide card keeps the answer picked in the panel.
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill(`call_tool ask_async ${JSON.stringify(long("plan"))}`);
      await box(page).press("Enter");
      await rail(page)
        .getByRole("button", { name: "Questions, 1 waiting for you" })
        .click({ timeout: 90_000 });
      const card = panel(page).getByRole("article", { name: "Question: Plan" });
      await card.getByRole("radio", { name: "Not yet" }).click();
      await card.getByRole("button", { name: "Read all" }).click();
      const wide = page.getByRole("dialog", { name: "Question: Plan" });
      await expect(wide.getByRole("table")).toBeVisible();
      await expect(wide.getByText("Paragraph 14 of the plan's notes.")).toBeVisible();
      await expect(wide.getByRole("radio", { name: "Not yet" })).toBeChecked();
      // Measured once its opening zoom (95% to 100%) has ended.
      await expect.poll(async () => (await wide.boundingBox())?.width ?? 0).toBeGreaterThan(600);
      await wide.getByRole("button", { name: "Send answer" }).click();
      await expect(
        transcript(page).getByText('Answer to your question "Plan" (plan):', { exact: false }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(wide).toHaveCount(0);

      // A phone: the wide card fills the screen; closing it brings the card back with its answer.
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const phone = await realApp.open({ path: "/", context });
      await expect(box(phone)).toHaveAttribute("placeholder", /./, { timeout: 120_000 });
      await box(phone).fill(`call_tool ask_async ${JSON.stringify(long("plan2"))}`);
      await phone.getByRole("button", { name: "Send" }).tap();
      await expect(
        transcript(phone).getByText("tool said: Asked 1 question (plan2).", { exact: false }),
      ).toBeVisible({ timeout: 90_000 });
      await phone.getByRole("button", { name: "Details", exact: true }).tap();
      const details = phone.getByRole("region", { name: "Chat details" });
      await details.getByRole("tab", { name: /^Questions/ }).tap();
      const phoneCard = details.getByRole("article", { name: "Question: Plan" });
      await phoneCard.getByRole("radio", { name: "Not yet" }).tap();
      await phoneCard.getByRole("button", { name: "Read all" }).tap();
      const full = phone.getByRole("dialog", { name: "Question: Plan" });
      await expect(full.getByRole("table")).toBeVisible();
      await expect.poll(async () => (await full.boundingBox())?.height ?? 0).toBeGreaterThan(800);
      await full.getByRole("button", { name: "Close" }).tap();
      await expect(full).toHaveCount(0);
      await expect(phoneCard.getByRole("radio", { name: "Not yet" })).toBeChecked();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "omp's question that stops the chat waits in the Questions panel too; answered there, the chat's card closes and omp goes on",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("ask_user");
      await box(page).press("Enter");
      const inChat = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(inChat).toBeVisible({ timeout: 60_000 });
      await rail(page).getByRole("button", { name: "Questions, 1 waiting for you" }).click();
      const listed = panel(page)
        .getByRole("region", { name: "omp waits for your answer" })
        .getByRole("region", { name: "Questions from omp" });
      await listed.getByRole("radio", { name: "Postgres" }).click();
      await listed.getByRole("button", { name: "Submit" }).click();
      await expect(inChat).toHaveCount(0);
      await expect(listed).toHaveCount(0);
      await expect(page.getByText(/^tool said: /).last()).toContainText("Postgres", {
        timeout: 60_000,
      });
      await expect(
        rail(page).getByRole("button", { name: "Questions", exact: true }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );
});
