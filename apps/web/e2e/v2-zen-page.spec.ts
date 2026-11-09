/// <reference path="../../zen/src/browser.d.ts" />
import { expect, type Page, test } from "@playwright/test";
import { clickTarget, hasText, readPage, scrollPage, typeInto } from "../../zen/src/page";

/**
 * What the Zen extension runs inside its tab (`apps/zen/src/page.ts`), run as Firefox runs it: the function's source,
 * called in the page with plain data. Each must work on a real page with nothing of its module around it.
 */
function inPage<A extends unknown[], R>(
  page: Page,
  func: (...args: A) => R,
  ...args: A
): Promise<R> {
  return page.evaluate(`(${func.toString()})(...${JSON.stringify(args)})`) as Promise<R>;
}

const TEST_PAGE = `<!doctype html>
<title>Test shop</title>
<h1>Shoes</h1>
<p>Winter boots, size 44, in stock.</p>
<a href="https://example.com/boots">Winter boots</a>
<a href="mailto:shop@example.com">Write to us</a>
<form id="search"><input id="query" name="q"><button type="submit">Search</button></form>
<button id="buy" onclick="window.bought = (window.bought ?? 0) + 1">Add to cart</button>
<button hidden onclick="window.hiddenClicked = true">Add to cart</button>
<div style="height: 3000px"></div>
<p id="end">The end</p>
<script>
  document.getElementById("search").addEventListener("submit", (event) => {
    event.preventDefault();
    window.searched = new FormData(event.target).get("q");
  });
</script>`;

test.describe("the Zen extension's page functions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(TEST_PAGE);
  });

  test("read_page: the title, the text, the web links (no mail link), and what is selected", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("p") as Node);
      getSelection()?.addRange(range);
    });
    const reading = await inPage(page, readPage, 20_000, 100);
    expect(reading.title).toBe("Test shop");
    expect(reading.text).toContain("Winter boots, size 44, in stock.");
    expect(reading.links).toEqual([{ text: "Winter boots", href: "https://example.com/boots" }]);
    expect(reading.selection).toBe("Winter boots, size 44, in stock.");
    expect(reading.truncated).toBe(false);
    const short = await inPage(page, readPage, 10, 0);
    expect(short.text).toHaveLength(10);
    expect(short.truncated).toBe(true);
    expect(short.links).toEqual([]);
  });

  test("click: by its words (a hidden one never), by a selector; what it cannot find, it says", async ({
    page,
  }) => {
    expect(await inPage(page, clickTarget, null, "add to cart")).toEqual({
      done: "Clicked button “Add to cart”.",
    });
    expect(await page.evaluate(() => (window as unknown as { bought?: number }).bought)).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { hiddenClicked?: boolean }).hiddenClicked),
    ).toBeUndefined();
    await inPage(page, clickTarget, "#buy", null);
    expect(await page.evaluate(() => (window as unknown as { bought?: number }).bought)).toBe(2);
    expect(await inPage(page, clickTarget, "#nothing", null)).toEqual({
      error: 'Nothing on the page matches "#nothing".',
    });
    expect(await inPage(page, clickTarget, "[[", null)).toEqual({
      error: '"[[" is not a CSS selector.',
    });
    expect(await inPage(page, clickTarget, null, "Checkout")).toEqual({
      error: 'No visible link or button says "Checkout".',
    });
  });

  test("type: into a field, then its form is sent; a button is no field", async ({ page }) => {
    expect(await inPage(page, typeInto, "#query", "boots 44", true)).toEqual({
      done: "Typed 8 characters into the input, and sent it.",
    });
    expect(await page.evaluate(() => (window as unknown as { searched?: string }).searched)).toBe(
      "boots 44",
    );
    expect(await page.inputValue("#query")).toBe("boots 44");
    expect(await inPage(page, typeInto, "#buy", "x", false)).toEqual({
      error: "The button is not a field to type into.",
    });
  });

  test("scroll and wait: to the bottom, to an element; the page's text is found", async ({
    page,
  }) => {
    const bottom = await inPage(page, scrollPage, "bottom", null, null);
    expect("done" in bottom && bottom.done).toMatch(/^The page is at \d+ of \d+ pixels\.$/);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1_000);
    await inPage(page, scrollPage, "top", null, null);
    await inPage(page, scrollPage, null, null, "#end");
    await expect(page.locator("#end")).toBeInViewport();
    expect(await inPage(page, hasText, "THE END")).toBe(true);
    expect(await inPage(page, hasText, "not on the page")).toBe(false);
  });
});
