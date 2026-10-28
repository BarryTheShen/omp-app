import { expect, realTest, sendPrompt, startChat } from "./real-omp";

// omp's questions must reach the person in the chat they are in, both in the first chat of a
// connection and in a chat opened after another one (#630: a host disposed by a re-render, or a host
// that serves one chat while the question belongs to another, left the turn waiting forever).
realTest.setTimeout(300_000);

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
    await question.getByRole("radio", { name: /^SQLite/ }).click();
    await question.getByRole("button", { name: "Review", exact: true }).click();
    await question.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  },
);

realTest(
  "omp's question appears in a second chat, opened after a first one, and the answer continues it",
  async ({ realApp }) => {
    const page = await realApp.open();
    // A busy page is the condition where a question sent during the second chat's opening went to the chat before it
    // (issue 1503): the page's CPU is throttled, as on a loaded machine, so the second chat opens while the first still does.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
    await startChat(page);
    const composer = await startChat(page);
    const prompt = "Please ask_user which database to use.";
    await sendPrompt(composer, prompt);
    // Throttled, the second chat can start opening just as Enter is pressed: the box then keeps the text under "Opening
    // session…" and sends nothing. Once that line has gone, a box that still holds the text with Send enabled was not
    // sent (a send waiting for omp keeps Send disabled), and the person presses Enter again.
    const opening = page
      .locator('[data-composer-blocked="true"]')
      .filter({ hasText: "Opening session" });
    await expect(opening).toHaveCount(0, { timeout: 120_000 });
    const send = page.getByRole("button", { name: "Send message" });
    if ((await composer.inputValue()) === prompt && (await send.isEnabled()))
      await composer.press("Enter");
    const question = page.getByRole("dialog");
    // Throttled, the send waits for the chat's draft to save through the server before omp gets it: 120 s, not 45 s.
    await expect(question).toBeVisible({ timeout: 120_000 });
    await expect(question).toContainText("Which database?");
    await question.getByRole("radio", { name: /^SQLite/ }).click();
    await question.getByRole("button", { name: "Review", exact: true }).click();
    await question.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  },
);
