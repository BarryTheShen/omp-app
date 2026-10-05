/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U3/tool-card/bash-playground.tsx",
      "--outdir",
      "dist/u3-bash-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the bash playground.");
  writeFileSync(
    join(DIST_ROOT, "u3-bash-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u3-bash-playground/bash-playground.js"></script>
  </head>
  <body>
    <div id="u3-bash-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("captures bash running, success and non-zero exit in light/dark/narrow layouts", async ({
  page,
}) => {
  await page.goto("/u3-bash-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("u3-bash-playground")).toBeVisible();
  await expect(page.getByTestId("tool-card-bash-running")).toHaveAttribute("data-phase", "running");
  await expect(page.getByTestId("tool-card-bash-success")).toHaveAttribute("data-phase", "success");
  await expect(page.getByTestId("tool-card-bash-failure")).toHaveAttribute("data-phase", "error");
  await page.screenshot({ path: "../../.data/screenshots/u3.5-bash-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/u3-bash-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("u3-bash-playground")).toBeVisible();
  await darkPage.screenshot({ path: "../../.data/screenshots/u3.5-bash-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/u3.5-bash-narrow.png", fullPage: true });
});
