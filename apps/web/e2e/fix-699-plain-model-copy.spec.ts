/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/*
 * Issue 699: the model settings and the model hub named internal terms (A1.4, CAS, ConfigStore, role map)
 * in plain sight. Neither component is mounted in the running app; each is shown by its playground page,
 * so this spec builds those two pages and reads them in light, dark and at 390 px.
 */

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SHOTS = join(APP_ROOT, "..", "..", ".data", "screenshots", "fix-699-model-copy");
const INTERNAL_TERMS = /\bCAS\b|A1\.4|ConfigStore|role map|config layer/;

interface PlaygroundPage {
  readonly entry: string;
  readonly bundle: string;
  readonly html: string;
  readonly root: string;
  readonly title: string;
}

const SETTINGS: PlaygroundPage = {
  entry: "src/modules/D1/settings/playground-entry.tsx",
  bundle: "fix-699-settings.js",
  html: "fix-699-settings.html",
  root: "d1-model-settings-playground-root",
  title: "D1 model settings",
};

const HUB: PlaygroundPage = {
  entry: "src/modules/D1/hub/playground-entry.tsx",
  bundle: "fix-699-hub.js",
  html: "fix-699-hub.html",
  root: "d1-model-hub-playground-root",
  title: "D1 model hub",
};

function buildPlaygroundPage(page: PlaygroundPage): void {
  execFileSync(
    "bun",
    ["build", page.entry, "--outfile", `dist/${page.bundle}`, "--target=browser"],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet for D1.");
  writeFileSync(
    join(DIST_ROOT, page.html),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>${page.title}</title>
  </head>
  <body>
    <div id="${page.root}"></div>
    <script type="module" src="/${page.bundle}"></script>
  </body>
</html>
`,
  );
}

async function turnDark(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
  buildPlaygroundPage(SETTINGS);
  buildPlaygroundPage(HUB);
});

test("the saved presets in model settings say what saving does, in light, dark and at 390 px", async ({
  page,
}) => {
  await page.goto(`/${SETTINGS.html}`);
  const presets = page.getByText("Save a set of models for each role and switch between them.");
  await expect(presets).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(INTERNAL_TERMS);
  await page.screenshot({ path: join(SHOTS, "settings-light.png"), fullPage: true });
  await turnDark(page);
  await page.screenshot({ path: join(SHOTS, "settings-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(presets).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "settings-narrow.png"), fullPage: true });
});

test("the model hub says where a saved preset is kept, in light, dark and at 390 px", async ({
  page,
}) => {
  await page.goto(`/${HUB.html}`);
  await page.locator("button", { hasText: /^Roles$/ }).click();
  const keptIn = page.getByText(
    "Saved for all workspaces or only for this workspace, as set in Settings.",
  );
  await expect(keptIn).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(INTERNAL_TERMS);
  await page.screenshot({ path: join(SHOTS, "hub-light.png"), fullPage: true });
  await turnDark(page);
  await page.screenshot({ path: join(SHOTS, "hub-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(keptIn).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "hub-narrow.png"), fullPage: true });
});
