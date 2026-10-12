/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const playground = "/p3-5-branch-summary.html";

function buildPlayground(): void {
  // The build writes the script and the stylesheet that the markdown module imports: two outputs, which `--outfile`
  // refuses. The script is copied out; the page links the app's own stylesheet only.
  const folder = join(DIST_ROOT, "p3-5-branch-summary-build");
  execFileSync(
    "bun",
    ["build", "src/modules/P3/summary/playground.tsx", "--outdir", folder, "--target=browser"],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  copyFileSync(join(folder, "playground.js"), join(DIST_ROOT, "p3-5-branch-summary.js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit a stylesheet for P3.5.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "p3-5-branch-summary.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Branch summary preview</title>
  </head>
  <body>
    <div id="p3-5-branch-summary-playground-root"></div>
    <script type="module" src="/p3-5-branch-summary.js"></script>
  </body>
</html>
`,
  );
}

async function expectStyled(page: Page): Promise<void> {
  const style = await page.locator("main").evaluate((main) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.className = "bg-background text-foreground";
    document.body.append(tokenProbe);
    const mainStyle = getComputedStyle(main);
    const tokenStyle = getComputedStyle(tokenProbe);
    const result = {
      background: mainStyle.backgroundColor,
      backgroundToken: tokenStyle.backgroundColor,
      color: mainStyle.color,
      colorToken: tokenStyle.color,
    };
    tokenProbe.remove();
    return result;
  });
  expect(style.background).toBe(style.backgroundToken);
  expect(style.color).toBe(style.colorToken);
}

// Waits for an opened row to settle, then checks in Chrome: chevron turned, summary in the
// foreground token, and the body drawn with its border.
async function expectOpenSummarySettled(divider: Locator): Promise<void> {
  await expect(divider.locator("summary > svg:last-child")).toHaveCSS("rotate", "180deg");
  const style = await divider.locator("details > div").evaluate((body) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.className = "border-border text-foreground";
    document.body.append(tokenProbe);
    const bodyStyle = getComputedStyle(body);
    const tokenStyle = getComputedStyle(tokenProbe);
    const result = {
      color: bodyStyle.color,
      colorToken: tokenStyle.color,
      borderWidth: bodyStyle.borderTopWidth,
      borderColor: bodyStyle.borderTopColor,
      borderColorToken: tokenStyle.borderTopColor,
    };
    tokenProbe.remove();
    return result;
  });
  expect(style.color).toBe(style.colorToken);
  expect(style.borderWidth).toBe("1px");
  expect(style.borderColor).toBe(style.borderColorToken);
}

async function expandBranchSummary(page: Page): Promise<void> {
  const divider = page.locator("[data-p3-branch-summary-divider]").first();
  const label = divider.locator("summary");
  await label.focus();
  await page.keyboard.press("Enter");
  await expect(divider.locator("details")).toHaveJSProperty("open", true);
  await expectOpenSummarySettled(divider);
  await expect(page.getByRole("heading", { name: "Kept branch" })).toBeVisible();
  await expect(page.getByText("The original conversation remains available.")).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
}

test.beforeAll(() => buildPlayground());

test("renders a safe expandable branch summary in light, dark and narrow views", async ({
  page,
}) => {
  await page.goto(playground);
  await expect(page).toHaveTitle("Branch summary preview");
  await expect(
    page.getByRole("heading", { level: 1, name: "Branch summary preview" }),
  ).toBeVisible();
  await expect(
    page.getByText("Expand a branch summary to read it without changing the conversation."),
  ).toBeVisible();
  await expandBranchSummary(page);
  await expectStyled(page);
  const emptyDivider = page.locator("[data-p3-branch-summary-divider]").nth(1);
  await emptyDivider.locator("summary").click();
  await expect(emptyDivider.getByText("No branch summary was provided.")).toBeVisible();
  await expect(emptyDivider.locator("summary > svg:last-child")).toHaveCSS("rotate", "180deg");
  await page.screenshot({
    path: "../../.data/screenshots/p3-5-branch-summary-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto(`${playground}?theme=dark`);
  await expect(dark.locator("html")).toHaveClass("dark");
  await expandBranchSummary(dark);
  await expectStyled(dark);
  await dark.screenshot({
    path: "../../.data/screenshots/p3-5-branch-summary-dark.png",
    fullPage: true,
  });
  await dark.close();

  const narrow = await page.context().newPage();
  await narrow.setViewportSize({ width: 390, height: 844 });
  await narrow.goto(playground);
  await expandBranchSummary(narrow);
  await expectStyled(narrow);
  const fitsNarrowViewport = await narrow.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fitsNarrowViewport).toBe(true);
  await narrow.screenshot({
    path: "../../.data/screenshots/p3-5-branch-summary-narrow.png",
    fullPage: true,
  });
  await narrow.close();
});

test("the chevron turns back and the summary hides when the row closes", async ({ page }) => {
  await page.goto(playground);
  const divider = page.locator("[data-p3-branch-summary-divider]").first();
  const chevron = divider.locator("summary > svg:last-child");
  await divider.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(divider.locator("details")).toHaveJSProperty("open", true);
  await expect(chevron).toHaveCSS("rotate", "180deg");
  await page.keyboard.press("Enter");
  await expect(divider.locator("details")).toHaveJSProperty("open", false);
  await expect(chevron).toHaveCSS("rotate", "none");
  await expect(page.getByRole("heading", { name: "Kept branch" })).toBeHidden();
});
