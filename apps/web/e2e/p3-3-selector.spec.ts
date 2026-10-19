/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P3/selector/playground.tsx",
      "--outfile",
      "dist/p3-3-selector.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the app stylesheet.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "p3-3-selector.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>Earlier messages</title>
  </head>
  <body>
    <div id="p3-3-selector-root"></div>
    <script type="module" src="/p3-3-selector.js"></script>
  </body>
</html>
`,
  );
}

function trackErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectTokenBackground(locator: Locator, token: string): Promise<void> {
  const colors = await locator.evaluate((element, tokenName) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${tokenName})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      actual: getComputedStyle(element).backgroundColor,
      expected,
      tokenValue: rootStyle.getPropertyValue(tokenName).trim(),
      pageBackground: rootStyle.getPropertyValue("--background").trim(),
      dialogBackground: rootStyle.getPropertyValue("--popover").trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      stylesheets: Array.from(document.styleSheets, (stylesheet) => stylesheet.href),
    };
  }, token);
  expect(
    colors.expected,
    JSON.stringify({
      actual: colors.actual,
      tokenValue: colors.tokenValue,
      pageBackground: colors.pageBackground,
      dialogBackground: colors.dialogBackground,
      bodyBackground: colors.bodyBackground,
      stylesheets: colors.stylesheets,
    }),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() => locator.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(colors.expected);
}

async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

const TRIGGER_NAME = "Edit an earlier message";
const FIXTURE_TEXT = "Use the attached notes to explain how caching improves response time.";
const LONG_TEXT = `https://example.com/${"segment".repeat(22).slice(0, 150)}`;

async function openSelector(page: Page, expectedText = FIXTURE_TEXT) {
  await page.getByRole("button", { name: TRIGGER_NAME }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toContainText(expectedText);
  return dialog;
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));
test.describe.configure({ mode: "serial" });

test("selects an earlier message, restores focus, and edits its exact source", async ({ page }) => {
  const assertLightPageHasNoErrors = trackErrors(page);
  await page.goto("/p3-3-selector.html");
  const playground = page.getByTestId("p3-3-selector-playground");
  await expect(playground).toBeVisible();

  const trigger = page.getByRole("button", { name: TRIGGER_NAME });
  const lightDialog = await openSelector(page);
  await expectTokenBackground(lightDialog, "--popover");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "p3-3-selector-light.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(lightDialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const selectionDialog = await openSelector(page);
  await selectionDialog.getByRole("option", { name: /Use the attached notes/ }).click();
  await selectionDialog.getByRole("button", { name: "Choose" }).click();
  const input = page.getByRole("textbox", { name: "Edit message" });
  await expect(input).toHaveValue(
    "Use the attached notes to explain how caching improves response time.",
  );
  await expect(page.getByText("notes.txt")).toBeVisible();
  await input.fill("A temporary edit");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const retrySelectionDialog = await openSelector(page);
  await retrySelectionDialog.getByRole("option", { name: /Use the attached notes/ }).click();
  await retrySelectionDialog.getByRole("button", { name: "Choose" }).click();
  const replacementInput = page.getByRole("textbox", { name: "Edit message" });
  await expect(replacementInput).toHaveValue(
    "Use the attached notes to explain how caching improves response time.",
  );
  await replacementInput.fill("A revised explanation");
  await replacementInput.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Replacement ready: A revised explanation");
  assertLightPageHasNoErrors();

  const darkPage = await page.context().newPage();
  const assertDarkPageHasNoErrors = trackErrors(darkPage);
  await darkPage.goto("/p3-3-selector.html?theme=dark");
  const darkPlayground = darkPage.getByTestId("p3-3-selector-playground");
  await expect(darkPlayground).toBeVisible();
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  const darkDialog = await openSelector(darkPage);
  await expectTokenBackground(darkDialog, "--popover");
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "p3-3-selector-dark.png"),
    fullPage: true,
  });
  assertDarkPageHasNoErrors();
  await darkPage.close();

  const narrowPage = await page.context().newPage();
  const assertNarrowPageHasNoErrors = trackErrors(narrowPage);
  await narrowPage.setViewportSize({ width: 390, height: 844 });
  await narrowPage.goto("/p3-3-selector.html");
  const narrowPlayground = narrowPage.getByTestId("p3-3-selector-playground");
  await expect(narrowPlayground).toBeVisible();
  const narrowDialog = await openSelector(narrowPage);
  await expectTokenBackground(narrowDialog, "--popover");
  await waitForFiniteAnimations(narrowPage);
  await narrowPage.screenshot({
    path: join(SCREENSHOT_ROOT, "p3-3-selector-narrow.png"),
    fullPage: true,
  });
  assertNarrowPageHasNoErrors();
  await narrowPage.close();
});

test("keeps a long unbroken earlier message inside the dialog on a narrow screen", async ({
  page,
}) => {
  const assertNoErrors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p3-3-selector.html?message=long");
  await expect(page.getByTestId("p3-3-selector-playground")).toBeVisible();
  const dialog = await openSelector(page, LONG_TEXT);
  await expect(dialog.getByRole("button", { name: "Choose" })).toBeInViewport();
  const spilled = await dialog.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll("*")).filter(
      (child) => child.getBoundingClientRect().right > frame.right + 1,
    ).length;
  });
  expect(spilled).toBe(0);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "p3-3-selector-long-narrow.png"),
    fullPage: true,
  });
  assertNoErrors();
});

test("returns focus to the trigger after a keyboard retry, then Escape closes the dialog", async ({
  page,
}) => {
  const assertNoErrors = trackErrors(page);
  await page.goto("/p3-3-selector.html?list=fail-once");
  await expect(page.getByTestId("p3-3-selector-playground")).toBeVisible();
  const trigger = page.getByRole("button", { name: TRIGGER_NAME });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const retry = page.getByRole("alert").getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  assertNoErrors();
});
