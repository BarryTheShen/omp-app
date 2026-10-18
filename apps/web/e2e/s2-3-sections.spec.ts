/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { realTest } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");

function normalizeColor(color: string): string {
  const normalizedPercentages = color.replace(/(\d+(?:\.\d+)?)%/gu, (_match, percentage: string) =>
    String(Number(percentage) / 100),
  );
  return normalizedPercentages.replace(/\b0\./gu, ".");
}

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/S2/shell/playground-entry.tsx",
      "--outfile",
      "dist/s2-3-sections-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for S2.3 sections.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "s2-3-sections-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Files and Shell settings</title>
  </head>
  <body>
    <div id="s2-sections-playground-root"></div>
    <script type="module" src="/s2-3-sections-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectCardToken(page: Page): Promise<void> {
  const card = page.getByTestId("settings-runtime-S2.filesLsp").locator("section[aria-labelledby]");
  const colors = await card.evaluate((element) => {
    const token = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
    return { background: getComputedStyle(element).backgroundColor, token };
  });
  expect(normalizeColor(colors.background)).toBe(normalizeColor(colors.token));
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("S2.3 sections render ConfigStore state and descriptor-backed apply reports", async ({
  page,
}) => {
  await page.goto("/s2-3-sections-playground.html");
  await expect(page.getByRole("heading", { name: "LSP", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bash", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Eval and Runtimes", exact: true })).toBeVisible();
  const reports = page.getByLabel("When settings take effect");
  await expect(reports).toHaveCount(3);
  await expect(reports.nth(0)).toContainText(
    "Live: LSP, Lazy LSP Startup, Shared Language Servers",
  );
  await expect(reports.nth(0)).not.toContainText("Reload required");
  await expect(reports.nth(1)).toContainText("Live: Bash, Allow Compound Commands");
  await expect(reports.nth(2)).toContainText("Live: Python Eval Backend");
  await expect(
    page.getByText("Use language tools to find definitions", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Block shell commands that have dedicated tools.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Use a new helper for each work item", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Source: Saved for all projects").first()).toBeVisible();
  await expectCardToken(page);
  await page.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-light.png"), fullPage: true });

  const dark = await page.context().newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/s2-3-sections-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByRole("heading", { name: "LSP", exact: true })).toBeVisible();
  await expectCardToken(dark);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-dark.png"), fullPage: true });

  await dark.setViewportSize({ width: 390, height: 844 });
  await expect(dark.getByRole("heading", { name: "Eval and Runtimes", exact: true })).toBeVisible();
  await expectCardToken(dark);
  const dimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-narrow.png"), fullPage: true });
  // Real 200% browser zoom halves the CSS-pixel viewport; a style.zoom property does not test the responsive layout.
  await dark.setViewportSize({ width: 195, height: 844 });
  await expect(dark.getByRole("heading", { name: "Eval and Runtimes", exact: true })).toBeVisible();
  const zoomedDimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(zoomedDimensions.viewport).toBe(195);
  expect(zoomedDimensions.content).toBeLessThanOrEqual(zoomedDimensions.viewport);
  await dark.close();
});

async function openS2Section(page: Page, tab: "Files" | "Shell", sectionName: string) {
  const settings = page.getByTestId("settings-screen");
  if (!(await settings.isVisible())) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings).toBeVisible();
  }
  await settings.getByRole("button", { name: tab, exact: true }).click();
  const sections = settings.getByRole("listbox", { name: `${tab} settings sections` });
  await expect(sections).toBeVisible();
  await sections.getByRole("option", { name: sectionName, exact: true }).click();
  const section = settings.getByRole("region", { name: sectionName, exact: true });
  await expect(section).toBeVisible();
  return section;
}

realTest(
  "S2.3 real settings describe live effects, clear stale save status, and resolve conflicts",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });

    const lsp = await openS2Section(page, "Files", "LSP");
    const report = lsp.getByLabel("When settings take effect");
    await expect(report).toContainText("Live: LSP, Lazy LSP Startup");
    await expect(report).not.toContainText("Reload required");
    await expect(
      lsp.getByText("Use language tools to find definitions", { exact: false }),
    ).toBeVisible();
    await expect(
      lsp.getByText("Start language servers when first needed instead of when a chat opens.", {
        exact: true,
      }),
    ).toBeVisible();

    const lazy = lsp.getByRole("checkbox", { name: "Lazy LSP Startup" });
    const initialLazy = await lazy.isChecked();
    const save = lsp.getByRole("button", { name: "Save changes", exact: true });
    await lazy.setChecked(!initialLazy);
    await save.click();
    await expect(lsp.getByText("Applied", { exact: true })).toBeVisible({ timeout: 20_000 });
    await lazy.setChecked(initialLazy);
    await expect(lsp.getByText("Applied", { exact: true })).toHaveCount(0);
    await expect(save).toBeEnabled();
    await lsp.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(lsp.getByText("Applied", { exact: true })).toHaveCount(0);

    const bash = await openS2Section(page, "Shell", "Bash");
    await expect(
      bash.getByText("Block shell commands that have dedicated tools.", { exact: true }),
    ).toBeVisible();
    await expect(
      bash.getByText(
        "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent.",
        { exact: true },
      ),
    ).toBeVisible();

    const timeout = bash.getByRole("spinbutton", { name: "direnv Load Timeout (ms)" });
    await timeout.fill("45000");
    await timeout.press("Tab");
    const bashSave = bash.getByRole("button", { name: "Save changes", exact: true });
    await expect(bashSave).toBeEnabled();
    await writeFile(join(realApp.agentDir, "config.yml"), "bash:\n  direnvLoadTimeoutMs: 60000\n");
    const conflict = page
      .getByTestId("settings-screen")
      .getByRole("alert")
      .filter({ hasText: "Settings changed elsewhere" });
    await expect(conflict).toBeVisible({ timeout: 20_000 });
    await expect(
      conflict.getByText(
        "Another change arrived while this section was open. Reload the latest values or keep your edits and save again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      conflict.getByRole("button", { name: "Reload latest", exact: true }),
    ).toBeEnabled();
    await expect(
      conflict.getByRole("button", { name: "Keep my edits", exact: true }),
    ).toBeEnabled();
    await conflict.getByRole("button", { name: "Keep my edits", exact: true }).click();
    await bashSave.click();
    await expect(bash.getByText("Applied", { exact: true })).toBeVisible({ timeout: 20_000 });

    const runtimes = await openS2Section(page, "Shell", "Eval and Runtimes");
    await expect(
      runtimes.getByText(
        "Keep one Python session for repeated evaluations, or start a fresh session for each call.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      runtimes.getByText(
        "Use a new helper for each work item instead of reusing helpers or batching items.",
        { exact: true },
      ),
    ).toBeVisible();
    const behaviorNote = runtimes.getByText(
      "Python and JavaScript evaluations use these options when they run. Existing Python sessions keep running until they close. For parallel tasks, choose whether to start a new helper for every task.",
      { exact: true },
    );
    await expect(behaviorNote).toBeVisible();
    await expect(behaviorNote).not.toContainText(/kernel|workpool/i);
    expect(realApp.problems).toEqual([]);
  },
);
