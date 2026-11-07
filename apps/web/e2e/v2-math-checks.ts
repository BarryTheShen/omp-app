import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Math in the new UI's transcript, as KaTeX draws it: `\boxed` gets its frame and `\underbrace` a brace as wide as
 * what it is under, which MathML alone did not draw in Chromium; the glyphs come from KaTeX's own fonts, and a display
 * equation never scrolls vertically. In Chromium and in WebKit (the desktop window's and Safari's engine), each from
 * its own spec file.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
/** The fake model's `math_shapes` reply (packages/server/test/fake-provider/fake-openai-server.ts) ends with it. */
const LAST_LINE = "That is all of the shapes.";

/** The checks in one engine: Chromium, or WebKit, each from its own spec file. */
export function defineMathChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(`new UI math in ${engine === "webkit" ? "WebKit" : "Chromium"}`, () => {
    realTest(
      "a boxed result is framed and a brace under a sum spans it, in KaTeX's fonts, and no equation scrolls vertically",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await box(page).fill("math_shapes");
        await box(page).press("Enter");
        await expect(page.getByText(LAST_LINE)).toBeVisible({ timeout: 60_000 });
        const reply = page.locator(".tr-md").filter({ hasText: LAST_LINE });
        await expect(reply.locator(".katex")).toHaveCount(2);
        await expect(reply.locator(".katex-error")).toHaveCount(0);

        // \boxed{E = mc^2}: a solid frame around the formula, its lines drawn.
        const frame = reply.locator(".katex .fbox");
        await expect(frame).toHaveCount(1);
        const framed = await frame.evaluate((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            line: style.borderTopStyle,
            lineWidth: Number.parseFloat(style.borderTopWidth),
            width: rect.width,
            height: rect.height,
          };
        });
        expect(framed.line).toBe("solid");
        expect(framed.lineWidth).toBeGreaterThan(0);
        expect(framed.width).toBeGreaterThan(40);
        expect(framed.height).toBeGreaterThan(10);

        // \underbrace{a + b + c}: the brace runs under the terms, about as wide as they are.
        const spans = await reply.locator(".katex-display").evaluate((display) => {
          const brace = display.querySelector(".stretchy");
          const base = brace?.closest(".munder")?.querySelector(".mord");
          if (brace === null || base === null || base === undefined) return null;
          const braceRect = brace.getBoundingClientRect();
          const baseRect = base.getBoundingClientRect();
          const drawn = [...brace.querySelectorAll("svg")].reduce(
            (width, svg) => width + svg.getBoundingClientRect().width,
            0,
          );
          return {
            drawn,
            braceWidth: braceRect.width,
            braceHeight: braceRect.height,
            baseWidth: baseRect.width,
          };
        });
        expect(spans).not.toBeNull();
        if (spans === null) return;
        expect(spans.braceHeight).toBeGreaterThan(3);
        expect(spans.drawn).toBeGreaterThan(spans.baseWidth * 0.8);
        expect(spans.braceWidth).toBeGreaterThan(spans.baseWidth * 0.8);

        // The glyphs come from KaTeX's fonts, served with the page.
        await expect
          .poll(() =>
            page.evaluate(async () => {
              await document.fonts.ready;
              return [...document.fonts].some(
                (face) => face.family.includes("KaTeX_Main") && face.status === "loaded",
              );
            }),
          )
          .toBe(true);

        // A display equation scrolls sideways at most: its box holds its ink.
        const overflow = await reply
          .locator(".tr-math")
          .evaluate((wrapper) => wrapper.scrollHeight - wrapper.clientHeight);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
