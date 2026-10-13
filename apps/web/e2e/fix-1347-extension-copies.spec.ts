import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1347 on real omp. Two copies of one plugin share an id: the global plugin folder has `shadowed` 1.0.0, and
 * the project's `.omp/plugins` has `shadowed` 2.0.0. omp keeps both and marks the earlier one shadowed. Before the fix,
 * a click on either row selected both rows and showed the first copy's details, so the copy omp uses (2.0.0) could not
 * be inspected from its own row. Now each row selects and shows only its own copy.
 */
const PACKAGE = "shadowed";
const GLOBAL_VERSION = "1.0.0";
const PROJECT_VERSION = "2.0.0";

/** A plugin package in a folder that omp's catalog reads: a `package.json` that depends on it, and the package. */
async function writePackage(folder: string, version: string): Promise<void> {
  await mkdir(join(folder, "node_modules", PACKAGE), { recursive: true });
  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({ dependencies: { [PACKAGE]: version } }),
  );
  await writeFile(
    join(folder, "node_modules", PACKAGE, "package.json"),
    JSON.stringify({ name: PACKAGE, version, omp: { extensions: ["index.js"] } }),
  );
}

/** The copy's version the inspector shows: each copy has its own. */
async function versionShown(inspector: Locator): Promise<string> {
  const text = (await inspector.textContent()) ?? "";
  const shown = [GLOBAL_VERSION, PROJECT_VERSION].find((version) => text.includes(version));
  if (shown === undefined) throw new Error(`the inspector shows no copy version: ${text}`);
  return shown;
}

realTest(
  "each copy of a shared plugin id is its own row: a click shows that copy's details and selects only that row",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await writePackage(join(dirname(realApp.agentDir), "plugins"), GLOBAL_VERSION);
    await writePackage(join(realApp.folder, ".omp", "plugins"), PROJECT_VERSION);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("settings-screen");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    await page.getByTestId("extension-tab-plugins").click();

    const rows = page.getByRole("list", { name: "plugins results" }).getByRole("button");
    await expect(rows).toHaveCount(2);
    const inspector = page.getByTestId("extension-inspector");

    // The first row shows its own copy; the second row must show the other copy, not the first one again.
    await rows.nth(0).click();
    await expect(rows.nth(0)).toHaveClass(/bg-accent/);
    const firstShown = await versionShown(inspector);
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveClass(/bg-accent/);
    await expect(rows.nth(0)).not.toHaveClass(/bg-accent/);
    const secondShown = await versionShown(inspector);
    expect(secondShown).not.toBe(firstShown);
    // The copy omp uses is the one that is not marked shadowed: the global 1.0.0 copy is the shadowed one.
    if (secondShown === GLOBAL_VERSION) await expect(inspector).toContainText("Shadowed");
    else await expect(inspector).not.toContainText("Shadowed");

    // Each capture is taken once the app's styles have loaded: the selected row has its surface colour.
    await mkdir(screenshots, { recursive: true });
    const center = page.getByTestId("extension-control-center");
    await expect(rows.nth(1)).toHaveCSS("background-color", /^(rgb|oklch)/);
    await center.screenshot({ path: join(screenshots, "fix-1347-extension-copies-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(rows.nth(1)).toHaveCSS("background-color", /^(rgb|oklch)/);
    await center.screenshot({ path: join(screenshots, "fix-1347-extension-copies-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // At 390 px a selected row opens its details in place of the list, with a Back control.
    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await expect(inspector).toHaveCSS("border-top-style", "solid");
    await center.screenshot({ path: join(screenshots, "fix-1347-extension-copies-narrow.png") });
  },
);
