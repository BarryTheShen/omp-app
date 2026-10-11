import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const PROMPT = "Please ask_user which database to use.";
const QUESTION = /Which database\?/;
/** The fake model's turn that runs for about twenty seconds (a bash sleep). */
const LONG_TURN = "run_queued_pair";

/** Asks the question, answers it with SQLite, and waits until the dialog has closed. */
async function askAndAnswer(page: Page): Promise<void> {
  await sendPrompt(page.getByRole("textbox", { name: "Message input" }), PROMPT);
  const question = page.getByRole("dialog", { name: QUESTION });
  await expect(question).toBeVisible({ timeout: 45_000 });
  await question.getByRole("option", { name: /^SQLite/ }).click();
  await question.getByRole("button", { name: "Choose", exact: true }).click();
  await expect(question).toBeHidden({ timeout: 30_000 });
}

/** The chat's transcript. A modal dialog hides the page from role queries, so the region is found hidden too. */
function transcriptOf(page: Page) {
  return page.getByRole("region", { name: "Conversation transcript", includeHidden: true });
}

/**
 * Checks that a reopened chat shows no question. The dialog is checked at once, which fails fast when a stale question
 * is already up. A stale question can also open a few seconds later, so the dialog is checked again after a turn that
 * lasts about twenty seconds. The chat's saved draft is restored as the chat opens, and it can replace text typed a moment
 * before, so the long turn is typed until its text stays in the composer, and only then sent.
 */
async function expectNoQuestionAfterALongTurn(page: Page): Promise<void> {
  await expect(page.getByRole("dialog", { name: QUESTION })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message input" });
  const stop = page.getByRole("button", { name: "Stop generating", includeHidden: true });
  await expect(async () => {
    await composer.fill(LONG_TURN, { timeout: 5_000 });
    await expect(composer).toHaveValue(LONG_TURN, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await composer.press("Enter", { timeout: 20_000 });
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await expect(stop).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole("dialog", { name: QUESTION })).toHaveCount(0);
}

/**
 * Issue #786, review regression: a question omp already had answered must not open again when its chat is opened
 * again. Opening a chat replays the events the server holds, and the answered question is one of them. A question
 * asked after the reload still opens, so the replay rule does not switch off live questions.
 */
realTest(
  "a question answered before a reload does not open again, and a question asked after it still opens",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    await askAndAnswer(page);

    await page.reload();
    await expect(transcriptOf(page).getByText(PROMPT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expectNoQuestionAfterALongTurn(page);

    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), PROMPT);
    await expect(page.getByRole("dialog", { name: QUESTION })).toBeVisible({ timeout: 45_000 });
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * The reviewer's switch: the answered chat is left once its turn has settled, and opened again from the list. Leaving a
 * chat whose turn still runs keeps its subscription, so the switch is only a regression for a settled chat.
 */
realTest(
  "a question answered before its settled chat was left does not open again when the chat is opened again",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    await askAndAnswer(page);
    await expect(page.getByText(/Conversation settled/).first()).toBeVisible({ timeout: 60_000 });

    await startChat(page);
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Please ask_user which database/ })
      .click();
    await expect(transcriptOf(page).getByText(PROMPT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expectNoQuestionAfterALongTurn(page);
    expect(realApp.problems).toEqual([]);
  },
);
