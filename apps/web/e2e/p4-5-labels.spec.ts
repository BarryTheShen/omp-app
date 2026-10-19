/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P4/labels/playground.tsx",
      "--outfile",
      "dist/p4-5-labels.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the saved-points stylesheet.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "p4-5-labels.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>Saved points</title>
  </head>
  <body>
    <div id="p4-labels-playground-root"></div>
    <script type="module" src="/p4-5-labels.js"></script>
  </body>
</html>
`,
  );
}

async function expectBackgroundToken(page: Page): Promise<void> {
  const evidence = await page.getByTestId("p4-labels-playground").evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const result = {
      actual: getComputedStyle(element).backgroundColor,
      expected: getComputedStyle(probe).backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    };
    probe.remove();
    return result;
  });
  expect(evidence.token).not.toBe("");
  expect(evidence.actual).toBe(evidence.expected);
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("shows the labels, when each was written, and the terminal-only reason", async ({ page }) => {
  await page.goto("/p4-5-labels.html");
  const playground = page.getByTestId("p4-labels-playground");
  await expect(playground).toBeVisible();
  await expectBackgroundToken(page);

  const section = page.getByRole("region", { name: "Labels" });
  const labels = section.getByRole("list", { name: "Labels" });
  await expect(labels.getByText("Review checkpoint")).toBeVisible();
  await expect(labels.getByText(/^Entry from /).first()).toBeVisible();
  await expect(
    section.getByText("Labels can only be changed in omp's terminal for now."),
  ).toBeVisible();
  await expect(section.getByRole("button", { name: "Edit labels" })).toBeDisabled();
  // The edit control and its reason start where the rows' text starts, so the section reads as one column.
  const rowTextLeft = await labels
    .getByText("Review checkpoint")
    .evaluate((element) => element.getBoundingClientRect().left);
  const editLeft = await section
    .getByRole("button", { name: "Edit labels" })
    .evaluate((element) => element.getBoundingClientRect().left);
  const reasonLeft = await section
    .getByText("Labels can only be changed in omp's terminal for now.")
    .evaluate((element) => element.getBoundingClientRect().left);
  expect(editLeft).toBeCloseTo(rowTextLeft, 0);
  expect(reasonLeft).toBeCloseTo(rowTextLeft, 0);
  const visibleText = await playground.textContent();
  expect(visibleText ?? "").not.toContain("p4-label-entry-");

  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "p4-5-labels-light.png"),
    fullPage: true,
  });
});

test("keeps labels read-only when the future capability is available", async ({ page }) => {
  await page.goto("/p4-5-labels.html?capability=available&theme=dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectBackgroundToken(page);

  const section = page.getByRole("region", { name: "Labels" });
  await expect(section.getByText("Labels are read-only in this app.")).toBeVisible();
  await expect(section.getByRole("button", { name: "Edit labels" })).toBeDisabled();
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "p4-5-labels-dark.png"),
    fullPage: true,
  });
});

test("keeps the empty state readable at narrow width and 200% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p4-5-labels.html?empty");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  await expectBackgroundToken(page);

  const section = page.getByRole("region", { name: "Labels" });
  await expect(section.getByText("No labels yet.")).toBeVisible();
  await expect(section.getByText("Labels added in omp's terminal show up here.")).toBeVisible();
  await expect(section.getByRole("list")).toHaveCount(0);
  await expect(
    section.getByText("Labels can only be changed in omp's terminal for now."),
  ).toBeVisible();
  await expect(section.getByRole("button", { name: "Edit labels" })).toBeDisabled();
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "p4-5-labels-narrow.png"),
    fullPage: true,
  });
});
