/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U1/scroll/scroll-playground.tsx",
      "--outdir",
      "dist/u1-8-scroll",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const appCss = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  const scrollCss = readdirSync(join(DIST_ROOT, "u1-8-scroll")).find((file) =>
    file.endsWith(".css"),
  );
  if (!appCss || !scrollCss) throw new Error("The U1 scroll playground styles were not built.");
  const playgroundHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${appCss}" />
    <link rel="stylesheet" href="/u1-8-scroll/${scrollCss}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u1-8-scroll/scroll-playground.js"></script>
  </head>
  <body>
    <div id="u1-8-scroll-root"></div>
  </body>
</html>
`;
  writeFileSync(join(DIST_ROOT, "u1-8-scroll.html"), playgroundHtml);
  writeFileSync(
    join(DIST_ROOT, "u1-8-scroll-dark.html"),
    playgroundHtml.replace('<html lang="en">', '<html lang="en" class="dark">'),
  );
}

function failOnConsoleErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectStyles(page: Page): Promise<void> {
  const shell = page.locator("[data-shell-layout]");
  const colors = await Promise.all([
    shell.evaluate((element) => getComputedStyle(element).backgroundColor),
    page
      .getByTestId("u1-8-background-token")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(colors[0]).toMatch(/^(rgb|oklch)/);
  expect(colors[0]).toBe(colors[1]);
}

async function firstVisibleMessage(
  viewport: Locator,
): Promise<{ readonly id: string; readonly top: number }> {
  const anchor = await viewport.evaluate((element) => {
    const viewportBounds = element.getBoundingClientRect();
    if (viewportBounds.width === 0) return null;
    const target = document.elementFromPoint(
      viewportBounds.left + viewportBounds.width / 2,
      viewportBounds.top + viewportBounds.height * 0.05,
    );
    const row = target?.closest("[data-message-id]");
    if (!(row instanceof HTMLElement) || !element.contains(row)) return null;
    const id = row.getAttribute("data-message-id");
    if (id === null) return null;
    return { id, top: row.getBoundingClientRect().top - viewportBounds.top };
  });
  if (anchor === null) throw new Error("No visible message can anchor the transcript.");
  return anchor;
}

async function expectAnchorRetained(
  viewport: Locator,
  anchor: { readonly id: string; readonly top: number },
): Promise<void> {
  const row = viewport.locator(`[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () => {
      const rowBox = await row.boundingBox();
      const viewportBox = await viewport.boundingBox();
      if (rowBox === null || viewportBox === null) return Number.POSITIVE_INFINITY;
      return Math.abs(rowBox.y - viewportBox.y - anchor.top);
    })
    .toBeLessThan(2);
}

async function remainingScroll(viewport: Locator): Promise<number> {
  return viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function openLongTranscript(page: Page, path = "/u1-8-scroll.html"): Promise<Locator> {
  await page.goto(path);
  await expectStyles(page);
  const viewport = page.getByRole("region", { name: "Messages" });
  await expect(viewport).toBeVisible();
  await expect(viewport).toHaveAttribute("tabindex", "0");
  await expect(viewport).toHaveAttribute("aria-live", "off");
  await expect(viewport.locator("[data-message-id]")).toHaveCount(120);
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "true",
  );
  await expect
    .poll(() =>
      viewport
        .locator("[data-message-id]")
        .first()
        .evaluate((element) => getComputedStyle(element).contentVisibility),
    )
    .toBe("auto");
  return viewport;
}

async function startStream(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: "Start stream" });
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Assistant is working…")).toBeVisible();
  await expect(start).toBeFocused();
}

async function scrollAway(viewport: Locator, page: Page): Promise<void> {
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(80);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
}

async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.beforeAll(buildPlaygroundPage);

async function addToStream(page: Page, times = 1): Promise<void> {
  const add = page.getByRole("button", { name: "Add to stream" });
  for (let index = 0; index < times; index += 1) await add.click();
}

test("keeps streaming and long transcripts anchored without stealing focus", async ({ page }) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  const viewport = await openLongTranscript(page);

  // A reply that starts while the reader is at the bottom is followed as it grows.
  await startStream(page);
  await addToStream(page, 2);
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);

  // The reader scrolls away; the reply keeps growing below without moving what they read.
  await scrollAway(viewport, page);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "false",
  );
  await expect(page.getByText("Assistant is working…")).toBeVisible();
  const streamAnchor = await firstVisibleMessage(viewport);
  await expect(page.getByText(/The latest message is below/)).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "The latest message is below." }),
  ).toHaveAttribute("aria-live", "polite");
  await addToStream(page, 3);
  await expectAnchorRetained(viewport, streamAnchor);
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(80);

  // Finishing the reply does not pull the reader down either.
  await page.getByRole("button", { name: "Finish stream" }).click();
  await expect(page.getByText("Conversation settled")).toBeVisible();
  await expectAnchorRetained(viewport, streamAnchor);
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(80);

  const prependAnchor = await firstVisibleMessage(viewport);
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expectAnchorRetained(viewport, prependAnchor);

  const reconnectAnchor = await firstVisibleMessage(viewport);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expectAnchorRetained(viewport, reconnectAnchor);
  await page.screenshot({ path: "../../.data/screenshots/u1-8-scroll-light.png", fullPage: false });

  // The keyboard path: Enter on the button lands on the real bottom and focuses the transcript.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const jump = page.getByRole("button", { name: "Jump to latest message" });
  await jump.focus();
  await page.keyboard.press("Enter");
  await expect(viewport).toBeFocused();
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "true",
  );

  // The mouse path from the very top: rows far away are drawn lazily, and the jump still lands on
  // the real bottom.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await viewport.press("Home");
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(80);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "false",
  );
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect(viewport).toBeFocused();
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "true",
  );

  await viewport.press("Home");
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(80);
  const resetDisplay = page.getByRole("button", { name: "Reset display" });
  await resetDisplay.focus();
  await page.keyboard.press("Enter");
  await expect(viewport).toBeFocused();
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);
  await expect(page.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "true",
  );

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(viewport).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  assertNoConsoleErrors();

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  const darkViewport = await openLongTranscript(darkPage, "/u1-8-scroll-dark.html");
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await startStream(darkPage);
  await addToStream(darkPage, 2);
  await expect.poll(() => remainingScroll(darkViewport)).toBeLessThan(80);
  await scrollAway(darkViewport, darkPage);
  await expect(darkPage.getByTestId("u1-8-scroll-playground")).toHaveAttribute(
    "data-is-at-bottom",
    "false",
  );
  const darkAnchor = await firstVisibleMessage(darkViewport);
  await addToStream(darkPage, 2);
  await expectAnchorRetained(darkViewport, darkAnchor);
  await darkPage.getByRole("button", { name: "Finish stream" }).click();
  await expect(darkPage.getByText("Conversation settled")).toBeVisible();
  await expect.poll(() => remainingScroll(darkViewport)).toBeGreaterThan(80);
  const darkJump = darkPage.locator('[data-slot="u1-scroll-to-bottom"]');
  await expect(darkJump).toBeAttached();
  await expect(darkJump).toBeEnabled();
  await expect(darkJump).toBeVisible();
  await expectStyles(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/u1-8-scroll-dark.png",
    fullPage: false,
  });

  await darkPage.setViewportSize({ width: 390, height: 844 });
  await expectAnchorRetained(darkViewport, darkAnchor);
  await expectStyles(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/u1-8-scroll-narrow.png",
    fullPage: false,
  });
  const narrowOverflow = await darkPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(narrowOverflow).toBeLessThanOrEqual(0);
  assertDarkNoConsoleErrors();
  await darkPage.close();
  assertNoConsoleErrors();
});

test("the transcript footer sits under the last message, stays on the bottom edge far from it, and its button is never covered", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  const viewport = await openLongTranscript(page);
  const geometry = () =>
    page.evaluate(() => {
      const viewportElement = document.querySelector('[data-slot="u1-thread-viewport"]');
      const footer = document.querySelector(
        '[data-slot="u1-scroll-follow-controls"]',
      )?.parentElement;
      const rows = viewportElement?.querySelectorAll("[data-message-id]");
      const lastRow = rows?.item(rows.length - 1);
      if (!viewportElement || !footer || !lastRow) return null;
      return {
        viewBottom: viewportElement.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
        footerBottom: footer.getBoundingClientRect().bottom,
        lastRowBottom: lastRow.getBoundingClientRect().bottom,
      };
    });

  // At the bottom the footer is under the last message, not over it.
  const atBottom = await geometry();
  if (atBottom === null) throw new Error("The transcript footer was not found.");
  expect(Math.abs(atBottom.footerBottom - atBottom.viewBottom)).toBeLessThan(1.5);
  expect(atBottom.lastRowBottom).toBeLessThanOrEqual(atBottom.footerTop + 1);

  // Far from the bottom it is still on the bottom edge of the viewport, with its button clickable.
  await viewport.press("Home");
  await expect.poll(() => remainingScroll(viewport)).toBeGreaterThan(1_000);
  const away = await geometry();
  if (away === null) throw new Error("The transcript footer was not found.");
  expect(Math.abs(away.footerBottom - away.viewBottom)).toBeLessThan(1.5);
  const jump = page.getByRole("button", { name: "Jump to latest message" });
  await expect(jump).toBeVisible();
  // Playwright refuses to click a button that something else covers.
  await jump.click({ timeout: 5_000 });
  await expect.poll(() => remainingScroll(viewport)).toBeLessThan(80);
  assertNoConsoleErrors();
});
