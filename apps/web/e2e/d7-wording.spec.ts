/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { appWrittenText, INTERNAL_WORDS } from "./d7-plain-text";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const PLAYGROUND = "/d7-wording-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D7/modes/playground-entry.tsx",
      "--outfile",
      "dist/d7-wording-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "d7-wording-playground.html"),
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
    <title>omp execution modes wording</title>
  </head>
  <body>
    <div id="d7-3-modes-playground-root"></div>
    <script type="module" src="/d7-wording-playground.js"></script>
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
      if (!section) throw new Error("The execution mode controls are missing.");
      const sectionStyle = getComputedStyle(section);
      return { background: sectionStyle.backgroundColor, color: sectionStyle.color };
    });
  expect(styles.background).toMatch(/^(oklch|rgb)/);
  expect(styles.color).toMatch(/^(oklch|rgb)/);
}

/** The words the app wrote in the controls must be plain; omp's own replies are not scanned. */
async function expectPlainWords(page: Page): Promise<void> {
  expect(await appWrittenText(page)).not.toMatch(INTERNAL_WORDS);
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

test("the mode descriptions and statuses use plain words in light, dark and narrow layouts", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(page);
  for (const sentence of [
    "Use larger context windows where the model supports them. This can cost more. Saved for every chat.",
    "Get faster replies when the model supports it.",
    "Use the provider's slower, lower-cost option when it has one.",
    "Replies run as usual when none of the settings above is on.",
    "Always available.",
  ]) {
    await expect(page.getByText(sentence, { exact: true })).toBeVisible();
  }
  await expectPlainWords(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByText("Always available.", { exact: true })).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Always available.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("a failed Fast change and a failed command change name the mode and say the app could not reach omp", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?fast=fails`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  const fast = page.getByRole("group", { name: "Fast mode controls" });
  await fast.getByRole("button", { name: "Turn on" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("Fast mode could not be changed.")).toBeVisible();
  await expect(
    page.getByText("The app could not reach omp. Try again.", { exact: true }),
  ).toBeVisible();
  await expectPlainWords(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-fast-failed-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  await page.goto(`${PLAYGROUND}?commands=fails`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  const computer = page.getByRole("group", { name: "Computer use controls" });
  await computer.getByRole("button", { name: "Turn on" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("Computer use could not be changed.")).toBeVisible();
  await expect(
    page.getByText("The app could not reach omp. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectPlainWords(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-command-failed-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?commands=fails&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await dark
    .getByRole("group", { name: "Computer use controls" })
    .getByRole("button", { name: "Turn on" })
    .click();
  await dark.mouse.move(0, 0);
  await expect(dark.getByText("Computer use could not be changed.")).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-command-failed-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("The app could not reach omp. Try again.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7-wording-command-failed-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});
