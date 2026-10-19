/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

const TIMEOUT = 15_000;

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U4/router/router-playground.tsx",
      "--outfile",
      "dist/u4-5-router-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U4.5 playground.");
  writeFileSync(
    join(DIST_ROOT, "u4-5-router-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp U4.5 router playground</title>
  </head>
  <body>
    <div id="u4-5-playground-root"></div>
    <script type="module" src="/u4-5-router-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlaygroundPage);

async function expectPopoverSurface(page: Page, surface: Locator): Promise<void> {
  const tokens = await page.evaluate(() => {
    const border = document.createElement("div");
    border.className = "border-foreground/10";
    const popover = document.createElement("div");
    popover.style.backgroundColor = "var(--popover)";
    document.body.append(border, popover);
    const result = {
      border: getComputedStyle(border).borderTopColor,
      popover: getComputedStyle(popover).backgroundColor,
    };
    border.remove();
    popover.remove();
    return result;
  });
  const style = await surface.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      radius: computed.borderRadius,
      borderWidth: computed.borderTopWidth,
      borderColor: computed.borderTopColor,
      background: computed.backgroundColor,
      shadow: computed.boxShadow,
    };
  });
  expect(style.radius).toBe("10px");
  expect(style.borderWidth).toBe("1px");
  expect(style.borderColor).toBe(tokens.border);
  expect(style.background).toBe(tokens.popover);
  const entries = style.shadow === "none" ? [] : style.shadow.split(/,(?![^(]*\))/);
  expect(
    entries.every((entry) => {
      const lengths = entry
        .replace(/[a-z-]+\([^)]*\)/gi, "")
        .match(/[-+]?(?:\d*\.?\d+)(?:px)?/gi)
        ?.map(Number.parseFloat);
      return (
        lengths !== undefined &&
        lengths.length > 0 &&
        lengths.slice(-4).every((value) => value === 0)
      );
    }),
  ).toBe(true);
  await expect(surface).toBeVisible({ timeout: TIMEOUT });
}

test("presents safe OAuth destination without auto-opening or leaking the URL", async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(TIMEOUT);
  await page.goto("/u4-5-router-playground.html");
  const opener = page.locator("#open-oauth");
  await opener.click();
  const prompt = page.getByRole("dialog");
  const promptSurface = prompt.locator("div.pointer-events-auto").first();
  await expect(prompt).toBeVisible({ timeout: TIMEOUT });
  await expectPopoverSurface(page, promptSurface);
  await expect(prompt).toContainText("accounts.example");
  await expect(prompt).not.toContainText("ephemeral");
  expect(page.context().pages()).toHaveLength(1);
  await page.screenshot({ path: "../../.data/screenshots/u4-5-oauth-light.png", fullPage: true });

  const darkPage = await context.newPage();
  darkPage.setDefaultTimeout(TIMEOUT);
  await darkPage.addInitScript({ content: 'document.documentElement.classList.add("dark")' });
  await darkPage.goto("/u4-5-router-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/, { timeout: TIMEOUT });
  await darkPage.locator("#open-oauth").click();
  const darkPrompt = darkPage.getByRole("dialog");
  const darkPromptSurface = darkPrompt.locator("div.pointer-events-auto").first();
  await expect(darkPrompt).toBeVisible({ timeout: TIMEOUT });
  await expectPopoverSurface(darkPage, darkPromptSurface);
  await darkPage.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await darkPage.screenshot({
    path: "../../.data/screenshots/u4-5-oauth-dark.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: TIMEOUT });
  await page.locator("#open-oauth").click();
  const narrowPrompt = page.getByRole("dialog");
  const narrowPromptSurface = narrowPrompt.locator("div.pointer-events-auto").first();
  await expect(narrowPrompt).toBeVisible({ timeout: TIMEOUT });
  await expectPopoverSurface(page, narrowPromptSurface);
  await page.screenshot({ path: "../../.data/screenshots/u4-5-oauth-narrow.png", fullPage: true });

  const presentationPage = await context.newPage();
  presentationPage.setDefaultTimeout(TIMEOUT);
  await presentationPage.goto("/u4-5-router-playground.html?presentation=1");
  const presentation = presentationPage
    .getByRole("status")
    .filter({ hasText: "OAuth handoff presented" });
  const presentationSurface = presentation.locator("div.rounded-surface").first();
  await expect(presentation).toBeVisible({ timeout: TIMEOUT });
  await expectPopoverSurface(presentationPage, presentationSurface);
  await presentationPage.screenshot({
    path: "../../.data/screenshots/u4-5-router-presentation-light.png",
    fullPage: true,
  });
  await presentationPage.close();
  await darkPage.close();
});
