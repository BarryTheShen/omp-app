/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D1/hub/playground-entry.tsx",
      "--outfile",
      "dist/d1-model-hub-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet for D1.");
  writeFileSync(
    join(DIST_ROOT, "d1-model-hub-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>D1 model hub</title>
  </head>
  <body>
    <div id="d1-model-hub-playground-root"></div>
    <script type="module" src="/d1-model-hub-playground.js"></script>
  </body>
</html>
`,
  );
}

async function computedStyleEvidence(page: Page) {
  return page.getByRole("heading", { name: "Model hub" }).evaluate((heading) => {
    const hub = heading.closest("section");
    const button = hub?.querySelector("button");
    const input = hub?.querySelector("input");
    if (!hub || !button || !input) throw new Error("D1 model hub controls are missing");
    const hubStyle = getComputedStyle(hub);
    const buttonStyle = getComputedStyle(button);
    const inputStyle = getComputedStyle(input);
    return {
      hubBackground: hubStyle.backgroundColor,
      hubColor: hubStyle.color,
      buttonBackground: buttonStyle.backgroundColor,
      buttonColor: buttonStyle.color,
      buttonRadius: buttonStyle.borderRadius,
      inputColor: inputStyle.color,
    };
  });
}

function assertComputedStyles(styles: Awaited<ReturnType<typeof computedStyleEvidence>>): void {
  expect(styles.hubBackground).toMatch(/^(ok|rgb)/);
  expect(styles.hubColor).toMatch(/^(ok|rgb)/);
  expect(styles.buttonBackground).toMatch(/^(ok|rgb|rgba)/);
  expect(styles.buttonColor).toMatch(/^(ok|rgb)/);
  expect(styles.buttonRadius).not.toBe("0px");
  expect(styles.inputColor).toMatch(/^(ok|rgb)/);
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("model hub groups providers, gates reply scope, and stays readable", async ({ page }) => {
  await page.goto("/d1-model-hub-playground.html");
  await expect(page.getByRole("heading", { name: "Model hub" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "alpha models" }).getByText("alpha", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "beta models" })).toBeVisible();
  await expect(page.getByRole("button", { name: "This reply: not available" })).toBeVisible();
  await expect(page.getByText("omp has no per-reply model override.")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "This reply models" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search model hub" }).fill("reasoner");
  await expect(
    page.getByRole("region", { name: "alpha models" }).getByText("Reasoner Large"),
  ).toBeVisible();
  assertComputedStyles(await computedStyleEvidence(page));
  await page.screenshot({
    path: "../../.data/screenshots/d1-3-model-hub-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/d1-model-hub-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass("dark");
  await expect(dark.getByRole("button", { name: "This reply: not available" })).toBeVisible();
  await expect(dark.getByRole("listbox", { name: "This reply models" })).toHaveCount(0);
  assertComputedStyles(await computedStyleEvidence(dark));
  await dark.screenshot({
    path: "../../.data/screenshots/d1-3-model-hub-dark.png",
    fullPage: true,
  });
  await dark.setViewportSize({ width: 390, height: 844 });
  await dark.screenshot({
    path: "../../.data/screenshots/d1-3-model-hub-narrow.png",
    fullPage: true,
  });
  await dark.close();
});
