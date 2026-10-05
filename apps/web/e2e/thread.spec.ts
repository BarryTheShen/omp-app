/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

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
  await page.screenshot({ path: "../../.data/screenshots/u1-2-empty-light.png", fullPage: true });
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await page.locator("html").evaluate((element) => element.classList.remove("dark"));

  await page.getByTestId("thread-play-fixture").click();
  await expect(page.getByRole("status")).toContainText("Assistant is working", { timeout: 10_000 });
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`Thread playground errors: ${[...pageErrors, ...consoleErrors].join("; ")}`);
  }
  await page.screenshot({
    path: "../../.data/screenshots/u1-2-streaming-light.png",
    fullPage: true,
  });

  await expect(page.getByRole("status")).toContainText("Conversation settled", { timeout: 30_000 });
  await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "../../.data/screenshots/u1-2-settled-light.png", fullPage: true });

  await page.getByTestId("thread-show-error").click();
  await expect(page.getByRole("alert")).toContainText("unavailable", { timeout: 5_000 });
  await page.screenshot({ path: "../../.data/screenshots/u1-2-error-light.png", fullPage: true });

  await page.reload();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/u1-2-empty-narrow.png", fullPage: true });
});
