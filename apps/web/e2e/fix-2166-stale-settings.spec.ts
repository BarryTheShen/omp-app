import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { realTest } from "./real-omp";

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

// omp dropped both Codex code-mode settings in 18.12.2; the omp the app pins is newer.
realTest.describe("omp has no Codex code-mode settings", () => {
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
