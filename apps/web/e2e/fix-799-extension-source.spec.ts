import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 799: the extension catalog showed omp's raw source name ("native") under each item. Here real omp
 * lists one item of each origin: a native extension, a native skill, a skill omp manages, and a plugin. Each
 * row names its origin in plain words; the raw provider name appears only in the selected item's details.
 */

const OWN_EXTENSION = "own-extension.ts";
realTest.use({
  seedExtensions: { [OWN_EXTENSION]: "export default function ownExtension() {}\n" },
});

/** A skill's SKILL.md with the frontmatter omp's catalog reads. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A skill for the origin check.\n---\nUse this skill to check the catalog.\n`;
}

/**
 * Writes the skill folders and a plugin package before omp starts. Plugins live under omp's configuration root,
 * `<home>/.omp/plugins` (omp v18.9.1 getPluginsDir; the app's catalog reads the same folder since #1287).
 */
async function seedOrigins(agentDir: string): Promise<void> {
  const skills = join(agentDir, "skills", "own-skill");
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), skillFile("own-skill"));
  const managed = join(agentDir, "managed-skills", "managed-skill");
  await mkdir(managed, { recursive: true });
  await writeFile(join(managed, "SKILL.md"), skillFile("managed-skill"));
  const plugins = join(dirname(agentDir), "home", ".omp", "plugins");
  const plugin = join(plugins, "node_modules", "demo-plugin");
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugins, "package.json"),
    JSON.stringify({
      name: "plugin-root",
      private: true,
      dependencies: { "demo-plugin": "1.0.0" },
    }),
  );
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "demo-plugin",
      version: "1.0.0",
      description: "A plugin for the origin check.",
      omp: {},
    }),
  );
}

/** Opens Settings from the header and selects its Tools tab, where the control center sits. */
async function openToolsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
}

/** Every origin's row names where it came from, and no row shows omp's raw provider name. */
async function expectPlainOrigins(page: Page): Promise<void> {
  await page.getByTestId("extension-tab-extensions").click();
  await expect(page.getByTestId(`extension-item-${OWN_EXTENSION}`)).toContainText(
    "From your extensions folder",
  );
  await page.getByTestId("extension-tab-plugins").click();
  await expect(page.getByTestId("extension-item-demo-plugin")).toContainText("From a plugin");
  await page.getByTestId("extension-tab-skills").click();
  await expect(page.getByTestId("extension-item-own-skill")).toContainText(
    "From your skills folder",
  );
  await expect(page.getByTestId("extension-item-managed-skill")).toContainText("Managed by omp");
  const center = page.getByTestId("extension-control-center");
  for (const raw of ["native", "omp-managed", "omp-plugins"]) {
    await expect(center).not.toContainText(raw);
  }
}

/** The selected item's details keep the plain origin first and omp's raw provider name in the details. */
async function expectDetails(page: Page): Promise<void> {
  await page.getByTestId("extension-tab-skills").click();
  await page.getByTestId("extension-item-own-skill").click();
  const inspector = page.getByTestId("extension-inspector");
  await expect(inspector).toContainText("Where it comes from");
  await expect(inspector).toContainText("From your skills folder");
  await expect(inspector).toContainText("Provider");
  await expect(inspector).toContainText("native");
}

realTest(
  "the catalog names each item's origin in plain words, and the details keep the raw provider name",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedOrigins(realApp.agentDir);
    const page = await realApp.open();
    await openToolsTab(page);
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    await expectPlainOrigins(page);
    await expectDetails(page);
    await waitForFiniteAnimations(page);
    await mkdir(join(screenshots, "fix-799-extension-source"), { recursive: true });
    await page.screenshot({
      path: join(screenshots, "fix-799-extension-source", "light.png"),
      fullPage: true,
    });
  },
);

realTest("the origin names read in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  await seedOrigins(realApp.agentDir);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await openToolsTab(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectDetails(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-799-extension-source", "dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("extension-control-center")).toBeVisible();
  await expect(page.getByTestId("extension-inspector")).toContainText("From your skills folder");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-799-extension-source", "narrow.png"),
    fullPage: true,
  });
});
