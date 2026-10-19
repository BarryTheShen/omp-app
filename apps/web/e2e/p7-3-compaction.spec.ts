/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const playground = "/p7-3-compaction-playground.html";

function buildPlayground(): void {
  // The build writes the script and the stylesheet that the markdown module imports: two outputs, which `--outfile`
  // refuses. The script is copied out; the page links the app's own stylesheet only.
  const folder = join(DIST_ROOT, "p7-3-compaction-playground-build");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P7/compaction/playground-entry.tsx",
      "--outdir",
      folder,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  copyFileSync(
    join(folder, "playground-entry.js"),
    join(DIST_ROOT, "p7-3-compaction-playground.js"),
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit a stylesheet for P7.3.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "p7-3-compaction-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Conversation compaction</title>
  </head>
  <body>
    <div id="p7-compaction-playground-root"></div>
    <script type="module" src="/p7-3-compaction-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStyled(page: Page): Promise<void> {
  const style = await page
    .getByRole("region", { name: "Conversation context" })
    .evaluate((panel) => {
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

async function expandSummary(page: Page): Promise<void> {
  const divider = page.getByRole("button", { name: "Conversation compacted remotely" });
  await divider.focus();
  await page.keyboard.press("Enter");
  await expect(divider).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText("Before compaction: 82,000 tokens. After compaction: 18,400 tokens."),
  ).toBeVisible();
  const summary = page.getByText("Read what was kept");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Current work" })).toBeVisible();
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlayground));

test("shows compaction progress and where the conversation continues in all themes and widths", async ({
  page,
}) => {
  await page.goto(playground);
  await expect(page.getByRole("heading", { name: "Compaction preview" })).toBeVisible();
  await expect(
    page.getByText("The prompt cache went cold, so omp processed 24,800 tokens again."),
  ).toBeVisible();
  await expect(page.getByText("omp is compacting your conversation.")).toBeVisible();
  await expandSummary(page);
  await expectStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/p7-3-compaction-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto(`${playground}?theme=dark`);
  await expect(dark.locator("html")).toHaveClass("dark");
  await expandSummary(dark);
  await expectStyled(dark);
  await dark.screenshot({
    path: "../../.data/screenshots/p7-3-compaction-dark.png",
    fullPage: true,
  });
  await dark.close();

  const narrow = await page.context().newPage();
  await narrow.setViewportSize({ width: 390, height: 844 });
  await narrow.goto(playground);
  await expandSummary(narrow);
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await expectStyled(narrow);
  await narrow.screenshot({
    path: "../../.data/screenshots/p7-3-compaction-narrow.png",
    fullPage: true,
  });
  await narrow.close();
});
