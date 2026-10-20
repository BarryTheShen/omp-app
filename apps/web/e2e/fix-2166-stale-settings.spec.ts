import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { realTest } from "./real-omp";

// Each case names its omp, so the result does not depend on which omp the test machine runs by default (on the test machine that
// default became 18.12.1 on 2026-10-20, #2234). Both binaries sit in the test machine's job cache.
const OMP_18_12_2 = "/cache/bun/zz-main-omp/omp-18.12.2";
const OMP_18_8_9 = "/cache/bun/zz-main-omp/omp-18.8.9";

const CODE_MODE_LABELS = ["Codex Code Mode", "Codex Code Mode Direct Tools"];

async function openServices(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Providers", exact: true }).click();
  await settings.getByRole("option", { name: "Services", exact: true }).click();
  await expect(settings.getByRole("region", { name: "Services" })).toBeVisible();
}
async function configText(agentDir: string): Promise<string> {
  try {
    return await readFile(`${agentDir}/config.yml`, "utf8");
  } catch {
    return "";
  }
}

realTest.describe("omp 18.12.2 dropped Codex code-mode settings", () => {
  realTest.use({ ompBinary: OMP_18_12_2 });

  realTest("hides both dropped rows and never writes either key", async ({ realApp }) => {
    const page = await realApp.open();
    await openServices(page);
    for (const label of CODE_MODE_LABELS) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    if ((await save.count()) > 0 && (await save.isEnabled())) await save.click();
    await expect.poll(() => configText(realApp.agentDir)).not.toContain("codeMode");
    expect(realApp.problems).toEqual([]);
  });
});

realTest.describe("omp 18.8.9 still supports Codex code-mode settings", () => {
  realTest.use({ ompBinary: OMP_18_8_9 });

  realTest("shows both Codex rows", async ({ realApp }) => {
    const page = await realApp.open();
    await openServices(page);
    for (const label of CODE_MODE_LABELS) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    expect(realApp.problems).toEqual([]);
  });
});
