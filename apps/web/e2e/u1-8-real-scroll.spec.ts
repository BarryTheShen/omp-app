import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt } from "./real-omp";

realTest.use({ seedLongTurn: 60 });

/**
 * A long chat in the real app on real omp:
 * - sending a message shows the newest one, even from far up;
 * - a reader who scrolls away while an answer arrives is left where they are, with "Jump to latest"
 *   reachable on the bottom edge (a run starting or ending is not a reason to move them);
 * - the button lands on the real bottom: rows far away are drawn lazily, so one scroll lands short.
 */
realTest(
  "real transcript follows a send, leaves a reader who scrolled away, and jumps to the real bottom",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Run the long job/ })
      .click();

    const viewport = page.getByRole("region", { name: "Messages" });
    await expect(viewport).toHaveAttribute("aria-live", "off");
    await expect(viewport).toHaveAttribute("tabindex", "0");
    const remainingScroll = () =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    const scrollTop = () => viewport.evaluate((element) => element.scrollTop);
    /** Rows far away are measured as they are reached, so the view keeps moving for a moment after a send. */
    const settled = async () => {
      let previous = "";
      let same = 0;
      await expect
        .poll(
          async () => {
            const now = await viewport.evaluate(
              (element) => `${Math.round(element.scrollTop)}/${element.scrollHeight}`,
            );
            same = now === previous ? same + 1 : 0;
            previous = now;
            return same;
          },
          { intervals: [300], timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(3);
    };
    const composer = page.getByRole("textbox", { name: "Message input" });
    const jump = page.getByRole("button", { name: "Jump to latest message" });

    await expect(page.getByText("All 60 steps are done.")).toBeAttached({ timeout: 60_000 });
    await expect.poll(remainingScroll).toBeLessThan(80);

    // Sending from far up shows the newest message.
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(remainingScroll).toBeGreaterThan(1_000);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await settled();
    await expect.poll(remainingScroll).toBeLessThan(80);

    // A reader who scrolls away while a slow tool runs is left alone, also when the tool finishes.
    await sendPrompt(composer, "Please run slow_tool now.");
    await expect(page.getByText("Please run slow_tool now.", { exact: true })).toBeVisible();
    await settled();
    await expect.poll(remainingScroll).toBeLessThan(80);
    await viewport.hover();
    await page.mouse.wheel(0, -1_500);
    await expect(jump).toBeVisible();
    const away = await scrollTop();
    await expect(page.getByText("slow-tool-done", { exact: true })).toBeAttached({
      timeout: 90_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 30_000 });
    expect(Math.abs((await scrollTop()) - away)).toBeLessThan(40);
    await expect(jump).toBeVisible();
    await page.screenshot({ path: join(screenshots, "u1-8-real-scroll", "away-from-bottom.png") });

    // The button lands on the real bottom and puts the focus on the transcript.
    await jump.click({ timeout: 5_000 });
    await expect(viewport).toBeFocused();
    await expect.poll(remainingScroll).toBeLessThan(80);
    await expect(jump).toBeHidden();
    expect(realApp.problems).toEqual([]);
  },
);
