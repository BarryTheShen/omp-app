import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

function answerTo(page: Page, tag: string): Locator {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

/**
 * The source row's update time once it has stopped moving. The row takes its time from the session file, and omp writes
 * the last answer to that file a moment after the answer shows, so a read taken as the answer appears can be overtaken.
 */
async function settledUpdatedAt(page: Page, source: Locator): Promise<string> {
  const time = source.locator("time");
  let updatedAt = await time.getAttribute("datetime");
  let unchangedReads = 0;
  for (let read = 0; unchangedReads < 2; read++) {
    if (read === 40) throw new Error("The source session's update time keeps moving.");
    await page.waitForTimeout(500);
    const current = await time.getAttribute("datetime");
    unchangedReads = current === updatedAt ? unchangedReads + 1 : 0;
    updatedAt = current;
  }
  if (updatedAt === null) throw new Error("The source session has no update time.");
  return updatedAt;
}

realTest.setTimeout(300_000);

realTest(
  "rewinding creates a Sessions-list row immediately and leaves the source conversation intact",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    for (const [tag, count] of [
      ["first", 1],
      ["second", 2],
      ["third", 3],
    ] as const) {
      await sendPrompt(composer, `count_reply ${tag}`);
      await expect(answerTo(page, tag)).toBeVisible({ timeout: 60_000 });
      await expect(answerTo(page, tag)).toHaveText(`count-${count} ${tag}`);
    }

    const sessions = page.getByRole("listbox", { name: "Session list" });
    const source = sessions.getByRole("option", { name: /count_reply first/ });
    await expect(source).toBeVisible();
    const sourceUpdatedAt = await settledUpdatedAt(page, source);

    await composer.focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox", { name: "Search commands" }).fill("conversation tree");
    await palette.getByRole("option", { name: /Conversation tree/ }).click();
    await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const tree = page.getByRole("tree", { name: "Conversation messages" });
    const second = tree.getByRole("treeitem", { name: /count_reply second/ });
    await second.click();
    await second.press("Enter");

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("count-1 first", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(transcript.getByText("count-2 second", { exact: true })).toHaveCount(0);
    await expect(transcript.getByText("count-3 third", { exact: true })).toHaveCount(0);

    const options = sessions.getByRole("option");
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    const original = options.filter({ has: page.locator(`time[datetime="${sourceUpdatedAt}"]`) });
    await expect(original).toHaveCount(1);
    const branch = options.filter({ hasNot: page.locator(`time[datetime="${sourceUpdatedAt}"]`) });
    await expect(branch).toHaveCount(1);
    await expect(branch).toHaveAttribute("aria-selected", "true");

    await original.click();
    await expect(transcript.getByText("count-1 first", { exact: true })).toBeVisible();
    await expect(transcript.getByText("count-2 second", { exact: true })).toBeVisible();
    await expect(transcript.getByText("count-3 third", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
