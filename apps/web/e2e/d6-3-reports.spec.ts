/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = "../../.data/screenshots";

/** Builds the reports playground into dist/, next to the app's own stylesheet from `vite build`. */
function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D6/reports/playground.tsx",
      "--outfile",
      "dist/d6-3-reports-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet; run `vite build` first.");
  writeFileSync(
    join(DIST_ROOT, "d6-3-reports-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp reports playground</title>
  </head>
  <body>
    <div id="d6-3-reports-playground-root"></div>
    <script type="module" src="/d6-3-reports-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

/** Opens one playground state in one theme; the playground applies the theme before its first render. */
async function open(page: Page, state: string, theme: "light" | "dark" = "light"): Promise<void> {
  await page.goto(`/d6-3-reports-playground.html?state=${state}&theme=${theme}`);
  // The stylesheet has loaded when the body is no longer in the browser's default serif face.
  await expect(page.locator("body")).not.toHaveCSS("font-family", /Times New Roman/);
}

test("the report shows omp's words, not its terminal colour codes, in light and dark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "ready");
  await expect(page.getByText("Context window: 128000 tokens (5% used)")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("38;2;");
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-ready-light.png`, fullPage: true });

  await open(page, "ready", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByText("Context window: 128000 tokens (5% used)")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-ready-dark.png`, fullPage: true });
});

test("the report reads on a 390 px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "usage");
  await expect(page.getByText("Input tokens: 0")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-usage-390.png`, fullPage: true });
});

test("loading, empty, failed and unavailable reports say what happened in plain words", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  await open(page, "loading");
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-loading-light.png`, fullPage: true });

  await open(page, "empty");
  await expect(page.getByText("omp sent no text for this report.")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-empty-light.png`, fullPage: true });

  await open(page, "failed");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-report-failed-light.png`, fullPage: true });

  await open(page, "unavailable");
  await expect(page.getByText(/Security scans need omp's command gateway/).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("capability");
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-report-unavailable-light.png`,
    fullPage: true,
  });
});

test("the security panel offers its actions above the last result, in light and on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "security");
  await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-light.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-390.png`, fullPage: true });
});

/** Opens the live reports panel and picks a report, which fails once so the panel offers a retry. */
async function failedReport(page: Page): Promise<void> {
  await open(page, "reports-live");
  await page.getByRole("button", { name: "Last three releases", exact: true }).click();
  await expect(page.getByText("omp stopped responding.")).toBeVisible();
}

test("a failed report in the real reports panel offers Try again, then shows omp's words", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await failedReport(page);
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-reports-failed-light.png`, fullPage: true });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Context window: 128000 tokens (5% used)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Last three releases", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-reports-retried-light.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-reports-retried-390.png`, fullPage: true });
});

test("the session trace choice says what it does, in dark and on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "reports-live", "dark");
  await page.getByRole("button", { name: "Session trace", exact: true }).click();
  await expect(page.getByText(/Starts omp's stats dashboard on this computer/)).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-reports-trace-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-reports-trace-390.png`, fullPage: true });
});

test("the security panel says what each action needs, and an empty required field opens nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "security-live");
  await page.getByLabel("Security action", { exact: true }).selectOption("cancel");
  await expect(
    page.getByText("The operation id of the scan to stop. Show scan status lists them."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Type the details this action needs.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-security-required-light.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-required-390.png`, fullPage: true });
});

test("validate asks first, and its panel says omp answers in the chat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "security-live", "dark");
  await page.getByLabel("Security action", { exact: true }).selectOption("validate");
  await page.getByLabel("Details (required)").fill("scan-1 finding-1");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Check this finding?")).toBeVisible();
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-security-confirm-dark.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Check the finding", exact: true }).click();
  await expect(
    page.getByText("omp is checking this finding in the chat; its answer appears there."),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-security-validate-dark.png`,
    fullPage: true,
    animations: "disabled",
  });
});

test("plan a scan takes options in a box that names them, in light, dark and on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "security");
  await page.getByLabel("Security action", { exact: true }).selectOption("plan");
  await expect(page.getByLabel("Details (optional)")).toHaveAttribute(
    "placeholder",
    "Options (optional), such as --path src",
  );
  await expect(page.getByText("Leave this empty to plan the whole project.")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-plan-light.png`, fullPage: true });

  await open(page, "security", "dark");
  await page.getByLabel("Security action", { exact: true }).selectOption("plan");
  await expect(page.getByText("Leave this empty to plan the whole project.")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-plan-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SCREENSHOTS}/d6-3-security-plan-390.png`, fullPage: true });
});

test("the scan and check confirmations use the default button, not the red one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "security-live");
  await page.getByLabel("Security action", { exact: true }).selectOption("scan");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const start = page.getByRole("button", { name: "Start the scan", exact: true });
  await expect(start).toBeVisible();
  await expect(start).toHaveClass(/bg-primary/);
  await expect(start).not.toHaveClass(/bg-destructive/);
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-security-scan-confirm-light.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByLabel("Security action", { exact: true }).selectOption("validate");
  await page.getByLabel("Details (required)").fill("scan-1 finding-1");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const check = page.getByRole("button", { name: "Check the finding", exact: true });
  await expect(check).toBeVisible();
  await expect(check).toHaveClass(/bg-primary/);
  await expect(check).not.toHaveClass(/bg-destructive/);
  await page.screenshot({
    path: `${SCREENSHOTS}/d6-3-security-check-confirm-light.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
});
