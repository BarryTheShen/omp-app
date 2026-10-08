import { expect, realTest, sendPrompt, startChat } from "./real-omp";

// omp's questions must reach the person in the chat they are in, both in the first chat of a
// connection and in a chat opened after another one (#630: a host disposed by a re-render, or a host
// that serves one chat while the question belongs to another, left the turn waiting forever).

realTest(
  "omp's question appears a moment after a new chat opens, and the answer continues the turn",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.waitForTimeout(1500);
    await sendPrompt(composer, "Please ask_user which database to use.");
    const question = page.getByRole("dialog");
    await expect(question).toBeVisible({ timeout: 45_000 });
    await expect(question).toContainText("Which database?");
    await question.getByText("SQLite").first().click();
    await question
      .getByRole("button", { name: /choose/i })
      .first()
      .click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  },
);

realTest(
  "omp's question appears in a second chat, opened after a first one, and the answer continues it",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    const composer = await startChat(page);
    await sendPrompt(composer, "Please ask_user which database to use.");
    const question = page.getByRole("dialog");
    await expect(question).toBeVisible({ timeout: 45_000 });
    await expect(question).toContainText("Which database?");
    await question.getByText("SQLite").first().click();
    await question
      .getByRole("button", { name: /choose/i })
      .first()
      .click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  },
);
