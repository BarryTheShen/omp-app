import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A running tool's live output in the new UI. A tool that prints its whole output and ends at once shows no live-output
 * box: the box flashed for a frame or two at its 160 px, and a view following the end of the chat jumped down and back
 * up. A tool that prints and runs on shows its output while it runs, and the box goes when it ends.
 */

/** Notes every live-output box the page adds or removes from now on. */
function watchLiveOutput(page: Page): Promise<void> {
  return page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { liveOutput: string[] }).liveOutput = seen;
    const isBox = (node: Node): boolean =>
      node instanceof Element &&
      (node.matches(".tv-partial") || node.querySelector(".tv-partial") !== null);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isBox(node)) seen.push("added");
        for (const node of record.removedNodes) if (isBox(node)) seen.push("removed");
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const liveOutput = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { liveOutput: string[] }).liveOutput]);

realTest.describe("new UI: a running tool's live output", () => {
  realTest.setTimeout(180_000);

  async function send(page: Page, prompt: string): Promise<void> {
    await startNewChat(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    await watchLiveOutput(page);
    await box.fill(prompt);
    await box.press("Enter");
  }

  realTest(
    "a tool that prints its output and ends at once never shows a live-output box",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      // The tool prints 20 lines after a second and ends 0.1 s later; the reply quotes them (its line breaks are
      // `<br>`s, so the text runs "1234…").
      await send(page, "burst_output_tool");
      await expect(page.getByText(/tool said: 1234/)).toBeVisible({ timeout: 60_000 });
      expect(await liveOutput(page)).toEqual([]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a tool that prints and runs on shows its output while it runs, and the box goes when it ends",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      // The tool prints 1 to 5, then runs 2 s more.
      await send(page, "streaming_output_tool");
      const box = page.locator(".tv-partial");
      await expect(box).toContainText("5", { timeout: 30_000 });
      await expect(page.getByText(/tool said: .*stream-done/)).toBeVisible({ timeout: 60_000 });
      await expect(box).toHaveCount(0);
      expect(await liveOutput(page)).toEqual(["added", "removed"]);
      expect(realApp.problems).toEqual([]);
    },
  );
});
