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

test("modes omp does not report start with neither button set, in every layout", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(page);
  for (const name of ["Computer use controls", "Extended context controls"]) {
    const group = page.getByRole("group", { name });
    await expect(group.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(group.getByRole("button", { name: "Turn off" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }
  await expect(
    page.getByText(
      "omp does not report whether this is on. Choose Turn on or Turn off for this chat.",
      { exact: true },
    ),
  ).toHaveCount(2);
  // The fake model has no slow mode and omp says so: the row gives that reason, and both buttons stay off.
  const slow = page.getByRole("group", { name: "Slow mode controls" });
  await expect(
    page.getByText("Slow mode is not available for this model.", { exact: true }),
  ).toBeVisible();
  await expect(slow.getByRole("button", { name: "Turn on" })).toBeDisabled();
  await expect(slow.getByRole("button", { name: "Turn off" })).toBeDisabled();
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-unknown-light.png"),
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
    path: join(SCREENSHOT_ROOT, "d7.3-modes-unknown-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-unknown-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("a failed Fast change keeps the last value omp reported, in every layout", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?fast=fails`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  const fast = page.getByRole("group", { name: "Fast mode controls" });
  await expect(
    page.locator("[data-d7-mode-controls]").getByText("Off", { exact: true }),
  ).toHaveCount(1);
  await fast.getByRole("button", { name: "Turn on" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("Fast mode could not be changed.")).toBeVisible();
  await expect(
    page.getByText("The app could not reach omp. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(fast.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(fast.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(fast.getByRole("button", { name: "Turn on" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await assertStyled(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-fast-failed-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?fast=fails&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(
    dark.locator("[data-d7-mode-controls]").getByText("Off", { exact: true }),
  ).toHaveCount(1);
  await dark
    .getByRole("group", { name: "Fast mode controls" })
    .getByRole("button", { name: "Turn on" })
    .click();
  await dark.mouse.move(0, 0);
  await expect(dark.getByText("Fast mode could not be changed.")).toBeVisible();
  await expect(dark.getByRole("button", { name: "Try again" })).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-fast-failed-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-fast-failed-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("a failed change to Computer use keeps both buttons enabled, in every layout", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?commands=fails`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  const computer = page.getByRole("group", { name: "Computer use controls" });
  await computer.getByRole("button", { name: "Turn on" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("Computer use could not be changed.")).toBeVisible();
  await expect(
    page.getByText("The app could not reach omp. Try again.", { exact: true }),
  ).toBeVisible();
  // omp never reported Computer use, so neither choice is set; both stay enabled for another try.
  await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(computer.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(computer.getByRole("button", { name: "Turn on" })).toBeEnabled();
  await expect(computer.getByRole("button", { name: "Turn off" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await assertStyled(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-failed-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?commands=fails&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  const darkComputer = dark.getByRole("group", { name: "Computer use controls" });
  await darkComputer.getByRole("button", { name: "Turn on" }).click();
  await dark.mouse.move(0, 0);
  await expect(dark.getByText("Computer use could not be changed.")).toBeVisible();
  await expect(darkComputer.getByRole("button", { name: "Turn off" })).toBeEnabled();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-failed-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(computer.getByRole("button", { name: "Turn on" })).toBeEnabled();
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-failed-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("a failed Turn off keeps the On that omp accepted, in every layout", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?commands=fails-after-first`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  const computer = page.getByRole("group", { name: "Computer use controls" });
  await computer.getByRole("button", { name: "Turn on" }).click();
  await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await computer.getByRole("button", { name: "Turn off" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("Computer use could not be changed.")).toBeVisible();
  await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(computer.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Both choices stay enabled; the chosen one is only marked aria-disabled, so this reads the real attribute.
  await expect(computer.getByRole("button", { name: "Turn on" })).toHaveJSProperty(
    "disabled",
    false,
  );
  await expect(computer.getByRole("button", { name: "Turn off" })).toHaveJSProperty(
    "disabled",
    false,
  );
  await assertStyled(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-kept-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?commands=fails-after-first&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  const darkComputer = dark.getByRole("group", { name: "Computer use controls" });
  await darkComputer.getByRole("button", { name: "Turn on" }).click();
  await expect(darkComputer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await darkComputer.getByRole("button", { name: "Turn off" }).click();
  await dark.mouse.move(0, 0);
  await expect(dark.getByText("Computer use could not be changed.")).toBeVisible();
  await expect(darkComputer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-kept-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dark.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d7.3-modes-command-kept-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("Slow mode says the wrap-up stage in plain words, in light, dark and narrow layouts", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?slow=wrap-up`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(page);
  const slow = page.getByRole("group", { name: "Slow mode controls" });
  await expect(
    page.getByText(
      /^On\. Your usage limit is reached\. Requests get a short wrap-up allowance, then .+/,
    ),
  ).toBeVisible();
  await expect(slow.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1200-slow-wrap-up-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?slow=wrap-up&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1200-slow-wrap-up-dark.png"),
    animations: "disabled",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText(
      /^On\. Your usage limit is reached\. Requests get a short wrap-up allowance, then .+/,
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1200-slow-wrap-up-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});

test("Slow mode says the low-priority stage and its allowance left in plain words", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?slow=low-priority`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await expect(
    page.getByText(
      /^On\. Requests run at low priority until your limit resets .+\. 62% of the low-priority allowance is left\.$/,
    ),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1200-slow-low-priority-light.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

test("Slow mode says it applies to this chat only, in light, dark and narrow layouts", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const sentence =
    "Use the provider's slower, lower-cost option when it has one. Applies to this chat only.";
  await page.goto(`${PLAYGROUND}?slow=session`);
  await expect(page.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(page);
  const slow = page.getByRole("group", { name: "Slow mode controls" });
  await expect(page.getByText(sentence, { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Use the provider's slower, lower-cost option when it has one. Saved for every chat.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(slow.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1300-slow-session-light.png"),
    animations: "disabled",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  const darkProblems = collectProblems(dark);
  await dark.goto(`${PLAYGROUND}?slow=session&theme=dark`);
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByTestId("d7-3-modes-playground")).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1300-slow-session-dark.png"),
    animations: "disabled",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(sentence, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "fix-1300-slow-session-narrow.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect([...problems, ...darkProblems]).toEqual([]);
});
