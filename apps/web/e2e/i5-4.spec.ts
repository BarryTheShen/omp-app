/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

test.describe.configure({ mode: "serial" });

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I5/settings/playground.tsx",
      "--outfile",
      "dist/i5-4-settings.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit the I5 settings stylesheet.");
  writeFileSync(
    join(DIST_ROOT, "i5-4-settings.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
  </head>
  <body>
    <div id="i5-settings-playground-root"></div>
    <script type="module" src="/i5-4-settings.js"></script>
  </body>
</html>
`,
  );
}

async function assertStyled(page: import("@playwright/test").Page): Promise<void> {
  const evidence = await page
    .getByRole("heading", { name: "Speech", exact: true })
    .evaluate((heading) => {
      const section = heading.closest("section");
      const button = section?.querySelector("button");
      const select = section?.querySelector("select");
      const sectionStyle = section ? getComputedStyle(section) : undefined;
      const buttonStyle = button ? getComputedStyle(button) : undefined;
      const selectStyle = select ? getComputedStyle(select) : undefined;
      return {
        background: sectionStyle?.backgroundColor,
        border: sectionStyle?.borderStyle,
        radius: sectionStyle?.borderRadius,
        buttonColor: buttonStyle?.color,
        selectColor: selectStyle?.color,
        selectFill: selectStyle?.webkitTextFillColor,
      };
    });
  expect(evidence.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(evidence.border).not.toBe("none");
  expect(evidence.radius).not.toBe("0px");
  expect(evidence.buttonColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(evidence.selectColor ?? evidence.selectFill).not.toBe("rgba(0, 0, 0, 0)");
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test("renders complete voice and speech settings with provenance in light mode", async ({
  page,
}) => {
  await page.goto("/i5-4-settings.html");
  await expect(page.getByRole("heading", { name: "Voice and speech" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speech", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await expect(
    page.getByText("Language used for speech recognition, for example en."),
  ).toBeVisible();
  await expect(page.getByTestId("live.voice-provenance")).toContainText(
    "Source: Saved for all projects",
  );
  await expect(page.getByLabel("Max In-Flight Requests: Provider name 1")).toHaveValue("openai");
  await expect(page.getByLabel("Max In-Flight Requests: Request limit 1")).toHaveValue("4");
  await expect(page.getByText("i5-playground-revision")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("secret-value");
  await assertStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/i5-4-settings-light.png",
    fullPage: true,
  });
  // The provider limits are an ordinary control inside the Services section, in descriptor order.
  const providerSection = page.locator('[data-i5-settings-section="I5.providersServices"]');
  const providerLimits = providerSection.locator('[data-slot="s1-structured-control"]');
  await expect(providerSection.getByText("Max In-Flight Requests")).toBeVisible();
  await providerLimits.getByRole("button", { name: "Add provider" }).click();
  await providerLimits.getByLabel("Max In-Flight Requests: Provider name 2").fill("anthropic");
  await providerLimits.getByLabel("Max In-Flight Requests: Request limit 2").fill("2");
  await expect(providerLimits.getByRole("button", { name: "Remove anthropic" })).toBeVisible();
  await expect(providerSection.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await expect(page.locator("body")).not.toContainText('{"openai"');
});

test("starts dark before render and remains usable at narrow width", async ({ page }) => {
  await page.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto("/i5-4-settings.html?theme=dark");
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await assertStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/i5-4-settings-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Voice and speech" })).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/i5-4-settings-narrow.png",
    fullPage: true,
  });
});
