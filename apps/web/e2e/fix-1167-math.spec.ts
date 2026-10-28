import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue #1167: math in an assistant reply is typeset, and a formula that is still being written shows its source.
 * The fake model's `stream_math` reply (packages/server/test/fake-provider/fake-openai-server.ts) has four inline formulas
 * (`$...$` and `\(...\)`), two display formulas (`$$...$$` and `\[...\]`), two prices in prose, and a code block.
 * The half-written states are pinned by the unit tests (apps/web/src/modules/U1/markdown/math.test.tsx): how the
 * streamed pieces arrive is not something this spec can control, so it does not assert on them.
 */
const PROMPT = "stream_math: explain the particle in a box";
const INLINE_FORMULAS = 4;
const DISPLAY_FORMULAS = 2;

declare global {
  interface Window {
    /** Set when a formula of the reply showed as a failure at any moment while the reply streamed. */
    formulaFailed?: boolean;
  }
}

/** The code block's own element: the Markdown `pre` around it has no state attribute. */
function codeOf(reply: Locator): Locator {
  return reply.locator("pre[data-code-state]");
}

/**
 * Watches the reply as it streams. A formula that failed shows as `katex-error` (KaTeX could not read it) or as
 * `math-source` (the fallback that shows a formula's source); either one at any moment sets `formulaFailed`.
 */
async function watchForFailures(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.formulaFailed = false;
    new MutationObserver(() => {
      const replies = document.querySelectorAll('[data-message-surface="assistant-text"]');
      const reply = replies.item(replies.length - 1);
      if (reply?.querySelector(".katex-error, .math-source") != null) window.formulaFailed = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

/** Whether a KaTeX font face has loaded: the formulas' glyphs come from the bundle, not from the network. */
async function katexFontLoaded(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(
      (face) => face.family.includes("KaTeX") && face.status === "loaded",
    );
  });
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** The reply's formulas are typeset, the prices and the code block are not, and no formula failed. */
async function expectTypeset(reply: Locator): Promise<void> {
  await expect(reply.locator(".katex")).toHaveCount(INLINE_FORMULAS + DISPLAY_FORMULAS);
  await expect(reply.locator(".katex-display")).toHaveCount(DISPLAY_FORMULAS);
  await expect(reply.locator(".katex-error, .math-source")).toHaveCount(0);
  await expect(codeOf(reply).locator(".katex")).toHaveCount(0);
  await expect(reply).toContainText("It costs $5 and $10, which is plain text.");
  await expect(codeOf(reply)).toHaveText("$y = mx + b$");
}

realTest(
  "#1167: a streamed reply typesets its formulas and keeps prices as text, and no formula fails while it streams",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const fontUrls: string[] = [];
    page.on("request", (request) => {
      if (/\.(woff2?|ttf)$/.test(new URL(request.url()).pathname)) fontUrls.push(request.url());
    });
    const composer = await startChat(page);
    await watchForFailures(page);
    await sendPrompt(composer, PROMPT);
    const reply = page
      .getByRole("region", { name: "Conversation transcript" })
      .locator('[data-message-surface="assistant-text"]')
      .last();
    await expect(codeOf(reply)).toHaveText("$y = mx + b$", { timeout: 120_000 });
    await waitForFiniteAnimations(page);

    // No formula showed as a failure at any moment while the reply streamed.
    expect(await page.evaluate(() => window.formulaFailed === true)).toBe(false);

    await expectTypeset(reply);
    expect(await katexFontLoaded(page)).toBe(true);
    // The formulas' fonts came from the app itself, and none from the network.
    expect(fontUrls.length).toBeGreaterThan(0);
    expect(fontUrls.filter((url) => new URL(url).origin !== new URL(page.url()).origin)).toEqual(
      [],
    );
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1167-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectTypeset(reply);
    await page.screenshot({ path: join(screenshots, "fix-1167-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#1167: the streamed reply in dark theme", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await sendPrompt(composer, PROMPT);
  const reply = page
    .getByRole("region", { name: "Conversation transcript" })
    .locator('[data-message-surface="assistant-text"]')
    .last();
  await expect(codeOf(reply)).toHaveText("$y = mx + b$", { timeout: 120_000 });
  await waitForFiniteAnimations(page);
  await expectTypeset(reply);
  await expectStylesLoaded(page);
  await page.screenshot({ path: join(screenshots, "fix-1167-dark.png") });
  expect(realApp.problems).toEqual([]);
});
