import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #944. A link whose text names another host keeps its address after it, "text (https://...)". Issue #825 hides the
 * address of every other link, so this is the one kind of link that shows one. The address follows the link with a break
 * opportunity, so a line never breaks inside its scheme. The host name is 24 characters: at 390 px its address starts near
 * a line end, and without that break opportunity the line breaks inside "https://" (measured on this layout).
 */
const HOST_LABEL_LENGTH = 24;

/** Whether the opening "(https://" of the shown address is on one line. */
async function schemeOnOneLine(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const destination = document.querySelector<HTMLElement>("[data-link-destination]");
    if (destination === null) return false;
    // The address is several text nodes ("(", the link, ")"): the range covers the first characters of all of them.
    const range = document.createRange();
    range.setStart(destination, 0);
    const walker = document.createTreeWalker(destination, NodeFilter.SHOW_TEXT);
    let remaining = "(https://".length;
    for (let node = walker.nextNode(); node !== null && remaining > 0; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      range.setEnd(node, Math.min(length, remaining));
      remaining -= Math.min(length, remaining);
    }
    const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
    return remaining === 0 && tops.size === 1;
  });
}

realTest(
  "real omp: a link to another host shows its address, and the address is not split inside https at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await sendPrompt(composer, `link_wrap_probe ${HOST_LABEL_LENGTH}`);
    await expect(page.locator("[data-link-destination]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByText("Assistant is working…")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator("[data-link-destination]")).toHaveText(
      "(https://other.example.net/login/page/one)",
    );
    expect(await schemeOnOneLine(page)).toBe(true);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-944-link-wrap-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
