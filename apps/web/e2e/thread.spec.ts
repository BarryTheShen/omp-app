/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const FIXTURE_PATH = join(APP_ROOT, "../../packages/omp-rpc/fixtures/prompt-stream.fixture.jsonl");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U1/thread/thread-playground.tsx",
      "--outdir",
      "dist/u1-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );

  const lines = readFileSync(FIXTURE_PATH, "utf8").trim().split("\n");
  const fixture = {
    header: JSON.parse(lines[0] ?? "{}"),
    frames: lines.slice(1).map((line) => JSON.parse(line)),
  };
  writeFileSync(join(DIST_ROOT, "prompt-stream-fixture.json"), JSON.stringify(fixture));

  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the thread playground.");
  writeFileSync(
    join(DIST_ROOT, "thread-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="thread-playground-root"></div>
    <script type="module" src="/u1-playground/thread-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectMarkdownStyles(page: Page): Promise<void> {
  await expect(page.locator("[data-markdown-inline]").first()).toBeVisible();
  await expect(page.locator("li").first()).toBeVisible();
  await expect(page.locator("blockquote")).toBeVisible();
  await expect(page.locator("th").first()).toBeVisible();
  const styles = await page.evaluate(() => ({
    inline: getComputedStyle(document.querySelector("[data-markdown-inline]") as Element).display,
    list: getComputedStyle(document.querySelector("li") as Element).listStyleType,
    quote: getComputedStyle(document.querySelector("blockquote") as Element).borderInlineStartStyle,
    header: getComputedStyle(document.querySelector("th") as Element).backgroundColor,
  }));
  expect(styles.inline).toBe("inline");
  expect(styles.list).not.toBe("none");
  expect(styles.quote).not.toBe("none");
  expect(styles.header).not.toBe("rgba(0, 0, 0, 0)");
}
test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders fixture empty, streaming, settled and AppFailure states", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/thread-playground.html");
  await expect(page.getByTestId("thread-fixture-controls")).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/u1-3-empty-light.png", fullPage: false });
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await page.screenshot({ path: "../../.data/screenshots/u1-3-empty-dark.png", fullPage: false });
  await page.locator("html").evaluate((element) => element.classList.remove("dark"));

  await page.getByTestId("thread-play-fixture").click();
  await expect(page.getByRole("status")).toContainText("Assistant is working", { timeout: 10_000 });
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`Thread playground errors: ${[...pageErrors, ...consoleErrors].join("; ")}`);
  }
  await page.screenshot({
    path: "../../.data/screenshots/u1-3-streaming-light.png",
    fullPage: false,
  });

  await expect(page.getByRole("status")).toContainText("Conversation settled", { timeout: 30_000 });
  await expect(page.locator('[data-slot="u1-tool-slot"]')).toHaveCount(1);
  const userBubble = page.locator('[data-message-surface="user-bubble"]').first();
  await expect(userBubble).toBeVisible();
  await expect(page.locator('[data-part-type="image"]')).toHaveCount(1);
  const userBubbleBackground = await userBubble.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(userBubbleBackground).not.toBe("rgba(0, 0, 0, 0)");
  const composerDock = page.locator('[data-shell-region="composer"]');
  await expect(composerDock).toBeVisible();
  await expect(page.locator('[data-shell-region="status"]')).toBeInViewport();
  const transcript = page.locator('[data-shell-region="transcript"]');
  const imagePart = page.locator('[data-part-type="image"]').first();
  await imagePart.scrollIntoViewIfNeeded();
  await expect(imagePart).toBeInViewport();
  await page.screenshot({
    path: "../../.data/screenshots/u1-3-conversation-light.png",
    fullPage: false,
  });
  await transcript.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(composerDock).toBeInViewport();
  await page.screenshot({
    path: "../../.data/screenshots/u1-3-settled-light.png",
    fullPage: false,
  });

  await page.getByTestId("thread-show-error").click();
  await expect(page.getByRole("alert")).toContainText("unavailable", { timeout: 5_000 });
  await page.screenshot({ path: "../../.data/screenshots/u1-3-error-light.png", fullPage: false });

  await page.reload();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/u1-3-empty-narrow.png", fullPage: false });
  await page.reload();
  await page.getByTestId("thread-show-markdown").click();
  await expect(page.getByRole("heading", { name: "Rich Markdown answer" })).toBeVisible();
  await expect(page.locator("[data-markdown-code]")).toHaveCount(1);
  await expect(page.locator("[data-markdown-table]")).toBeVisible();
  await expectMarkdownStyles(page);
  const richLight = page.getByRole("region", { name: "Rich Markdown answer" });
  await richLight.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../.data/screenshots/u1-4-rich-light.png", fullPage: false });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/thread-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await darkPage.getByTestId("thread-show-markdown").click();
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByRole("heading", { name: "Rich Markdown answer" })).toBeVisible();
  await expectMarkdownStyles(darkPage);
  const darkBackground = await darkPage.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(darkBackground).not.toBe("rgb(255, 255, 255)");
  const richDark = darkPage.getByRole("region", { name: "Rich Markdown answer" });
  await richDark.scrollIntoViewIfNeeded();
  await darkPage.screenshot({
    path: "../../.data/screenshots/u1-4-rich-dark.png",
    fullPage: false,
  });

  await darkPage.setViewportSize({ width: 390, height: 844 });
  await darkPage.screenshot({
    path: "../../.data/screenshots/u1-4-rich-narrow.png",
    fullPage: false,
  });
  await darkPage.close();
});
