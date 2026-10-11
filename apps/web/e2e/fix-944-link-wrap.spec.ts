import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * Issue #944. A link is shown with its address after it, "text (https://…)". The address followed the link with no
 * break opportunity, so at 390 px a line broke inside "https". The line may break before the address, never inside
 * its scheme. The message holds links whose texts have different lengths, so at least one address starts near the
 * end of a line.
 */
const LINKS = Array.from({ length: 10 }, (_, index) => {
  const text = `docs-${"x".repeat(14 + index * 2)}`;
  return `[${text}](https://example.test/page/${index})`;
}).join(" ");

/** For each shown address: whether its opening "(https://" is on one line. */
async function schemeLines(page: Page): Promise<readonly boolean[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-link-destination]")].map((destination) => {
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
    }),
  );
}

realTest(
  "real omp: a link's address is not split inside https at 390 px, in light and dark",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, `Links: ${LINKS}`);
    await expect(page.locator("[data-link-destination]")).toHaveCount(10, { timeout: 60_000 });
    await page.setViewportSize({ width: 390, height: 844 });

    expect(await schemeLines(page)).toEqual(Array.from({ length: 10 }, () => true));
    await page.screenshot({ path: join(screenshots, "fix-944-link-wrap-light-390.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    expect(await schemeLines(page)).toEqual(Array.from({ length: 10 }, () => true));
    await page.screenshot({ path: join(screenshots, "fix-944-link-wrap-dark-390.png") });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    expect(await schemeLines(page)).toEqual(Array.from({ length: 10 }, () => true));
    await page.screenshot({ path: join(screenshots, "fix-944-link-wrap-light-1280.png") });
    expect(realApp.problems).toEqual([]);
  },
);
