/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");

function buildPlayground(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for operations panels.");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D6/operations/playground.tsx",
      "--outdir",
      "dist/d6-5-operations",
      "--target=browser",
    ],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );
  writeFileSync(
    join(DIST_ROOT, "d6-5-operations.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/d6-5-operations/playground.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  );
}

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(main).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return { background: normalize(background), token: normalize(token), rawToken: token };
  });
  expect(colors.rawToken).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

realTest(
  "real omp opens a chat before the local operations fallback showcase",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    buildPlayground();
    mkdirSync(screenshots, { recursive: true });
    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "pong");
    await expect(app.getByText("pong").first()).toBeVisible({ timeout: 60_000 });

    const browser = app.context().browser();
    if (browser === null) throw new Error("The browser is unavailable for operations panels.");
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    const origin = new URL(app.url()).origin;
    await page.goto(`${origin}/d6-5-operations.html#token=${encodeURIComponent(realApp.token)}`);
    await expect(page.getByTestId("d6-5-operations-playground")).toBeVisible();
    await expect(page.getByRole("region", { name: "Side questions" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Cleanse" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Rule draft" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pause screen" })).toBeVisible();
    await expect(page.getByText("Questions stay separate from the chat.")).toBeVisible();
    await expect(
      page.getByText("Pause is local to this app and does not stop omp work."),
    ).toBeVisible();
    await expect(page.getByText("Using bash")).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toHaveCount(2);
    const longQuestion = page.getByText("Q".repeat(200), { exact: true }).first();
    const longComplaint = page.getByText("C".repeat(200), { exact: true }).first();
    await expect(longQuestion).toBeVisible();
    await expect(longComplaint).toBeVisible();
    await expect(
      page
        .getByRole("option", { name: /Q{200}/ })
        .locator("[title]")
        .first(),
    ).toHaveAttribute("title", "Q".repeat(200));
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "d6.5-operations-light.png"), fullPage: true });

    await page.goto(
      `${origin}/d6-5-operations.html?scenario=save-failed#token=${encodeURIComponent(realApp.token)}`,
    );
    await expect(page.getByText("The rule draft failed.")).toBeVisible();
    await expect(page.getByText("C".repeat(200), { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Before replying, check the result and name the next action."),
    ).toBeVisible();
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "d6.5-operations-error-with-content.png"),
      fullPage: true,
    });
    await page.goto(`${origin}/d6-5-operations.html#token=${encodeURIComponent(realApp.token)}`);
    await page.addInitScript(() => {
      if (document.documentElement) document.documentElement.classList.add("dark");
      else
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            document.documentElement.classList.add("dark");
          },
          { once: true },
        );
    });
    await page.reload();
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "d6.5-operations-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectTokenBackground(page);
    await expect(page.getByRole("region", { name: "Pause screen" })).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "d6.5-operations-narrow.png"),
      fullPage: true,
    });
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await context.close();
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
