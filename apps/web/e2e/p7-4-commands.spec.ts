/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const playground = "/p7-4-command-playground.html";

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P7/commands/playground-entry.tsx",
      "--outfile",
      "dist/p7-4-command-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit a stylesheet for P7.4.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "p7-4-command-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Command result</title>
  </head>
  <body>
    <div id="p7-command-playground-root"></div>
    <script type="module" src="/p7-4-command-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStyled(page: Page): Promise<void> {
  const style = await page.getByRole("region", { name: "Command report" }).evaluate((panel) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.className = "bg-sidebar text-sidebar-foreground";
    document.body.append(tokenProbe);
    const panelStyle = getComputedStyle(panel);
    const tokenStyle = getComputedStyle(tokenProbe);
    const result = {
      background: panelStyle.backgroundColor,
      backgroundToken: tokenStyle.backgroundColor,
      color: panelStyle.color,
      colorToken: tokenStyle.color,
    };
    tokenProbe.remove();
    return result;
  });
  expect(style.background).toBe(style.backgroundToken);
  expect(style.color).toBe(style.colorToken);
}

async function expectReport(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Command result preview" })).toBeVisible();
  await expect(page.getByText("Statistics dashboard is ready.")).toBeVisible();
  await expect(page.getByText("Open this address: http://127.0.0.1:3847")).toBeVisible();
  await expect(page.getByText("No response was started.")).toBeVisible();
  await expect(page.getByText("The prompt has settled.")).toBeVisible();
  await expect(page.getByText("The session has settled.")).toBeVisible();
  await expect(page.getByText("Thinking level changed")).toBeVisible();
  await expect(page.getByText("Extra high")).toBeVisible();
  await expect(page.getByText("xhigh")).toHaveCount(0);
}

test.beforeAll(() => buildPlayground());

test("shows ordered command output and safe updates in light, dark, and narrow layouts", async ({
  page,
}) => {
  await page.goto(playground);
  await expectReport(page);
  await expect(page.getByRole("region", { name: "Command report" })).toBeVisible();
  const outputRows = page.locator("[data-p7-command-output]");
  await expect(outputRows).toHaveCount(3);
  const longOutput = outputRows.nth(2).locator("p").nth(1);
  await expect(longOutput).toHaveCSS("overflow-y", "auto");
  const hasLongContent = await longOutput.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  expect(hasLongContent).toBe(true);
  await expectStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/p7-4-commands-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto(`${playground}?theme=dark`);
  await expect(dark.locator("html")).toHaveClass("dark");
  await expectReport(dark);
  await expectStyled(dark);
  await dark.screenshot({
    path: "../../.data/screenshots/p7-4-commands-dark.png",
    fullPage: true,
  });
  await dark.close();

  const narrow = await page.context().newPage();
  await narrow.setViewportSize({ width: 390, height: 844 });
  await narrow.goto(playground);
  await expectReport(narrow);
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await expectStyled(narrow);
  await narrow.screenshot({
    path: "../../.data/screenshots/p7-4-commands-narrow.png",
    fullPage: true,
  });
  await narrow.close();
});
