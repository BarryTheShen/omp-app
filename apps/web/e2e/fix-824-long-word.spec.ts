import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * Issue #824. A reply with a 306-character word and no spaces ran past the reply and was cut at the panel
 * border, and at 390 px the message area scrolled sideways. The fake model answers `long_word_probe` with
 * that token; the reply must wrap it, and nothing may run past its box or make the page scroll sideways.
 */
const REPLY_END = "end of the token.";

async function measureReply(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="u1-thread-viewport"]');
    const reply = [
      ...document.querySelectorAll<HTMLElement>('[data-message-surface="assistant-text"]'),
    ].find((element) => element.textContent?.includes("token-"));
    const paragraph = reply?.querySelector("p");
    if (!viewport || !reply || !paragraph)
      throw new Error("The reply with the token is not shown.");
    const text = document.createRange();
    text.selectNodeContents(paragraph);
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewportOverflow: viewport.scrollWidth - viewport.clientWidth,
      replyOverflow: reply.scrollWidth - reply.clientWidth,
      textRightOverrun: text.getBoundingClientRect().right - reply.getBoundingClientRect().right,
      overflowWrap: getComputedStyle(reply).overflowWrap,
    };
  });
}

async function expectWrapped(page: Page): Promise<void> {
  const measure = await measureReply(page);
  expect(measure.pageOverflow).toBeLessThanOrEqual(0);
  expect(measure.viewportOverflow).toBeLessThanOrEqual(0);
  expect(measure.replyOverflow).toBeLessThanOrEqual(0);
  expect(measure.textRightOverrun).toBeLessThanOrEqual(1);
  expect(measure.overflowWrap).toBe("anywhere");
}

realTest(
  "real omp: a 306-character word without spaces wraps inside the reply at 1280 and 390 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "long_word_probe");
    await expect(page.getByText(REPLY_END)).toBeVisible({ timeout: 60_000 });

    await page.setViewportSize({ width: 1280, height: 900 });
    await expectWrapped(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-824-light-1280.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expectWrapped(page);
    await page.screenshot({ path: join(screenshots, "fix-824-narrow-390.png") });
  },
);

realTest("real omp: the wrapped reply reads in dark mode at 1280 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  const composer = await startChat(page);
  await sendPrompt(composer, "long_word_probe");
  await expect(page.getByText(REPLY_END)).toBeVisible({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectWrapped(page);
  await page.screenshot({ path: join(screenshots, "fix-824-dark-1280.png") });
});
