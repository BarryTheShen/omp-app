/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const PLAYGROUND = "/d7-3-modes-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D7/modes/playground-entry.tsx",
      "--outfile",
      "dist/d7-3-modes-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet for D7.3.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "d7-3-modes-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/assets/${css}" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <title>omp execution modes</title>
  </head>
  <body>
    <div id="d7-3-modes-playground-root"></div>
    <script type="module" src="/d7-3-modes-playground.js"></script>
  </body>
</html>
`,
  );
}

async function assertStyled(page: Page): Promise<void> {
  const styles = await page
    .getByRole("heading", { name: "Execution modes" })
    .evaluate((heading) => {
      const section = heading.closest("section");
      const button = section?.querySelector("button");
      if (!section || !button) throw new Error("The execution mode controls are missing.");
      const sectionStyle = getComputedStyle(section);
      return {
        background: sectionStyle.backgroundColor,
        color: sectionStyle.color,
      };
    });
  expect(styles.background).toMatch(/^(ok|rgb)/);
  expect(styles.color).toMatch(/^(ok|rgb)/);
}

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  return problems;
}

test.beforeAll(buildPlaygroundPage);

test("renders mode controls in light, dark and narrow layouts", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(page);
  await page.getByRole("button", { name: "Headless" }).click();
  await expect(page.getByRole("button", { name: "Headless" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const fast = page.getByRole("group", { name: "Fast mode controls" });
  await fast.getByRole("button", { name: "Turn on" }).click();
  await expect(
    page.locator("[data-d7-mode-controls]").getByText("On", { exact: true }),
  ).toHaveCount(1);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});
