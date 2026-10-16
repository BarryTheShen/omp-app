/// <reference types="node" />
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const DATA = resolve(process.cwd(), "../../.data/fix-1775-empty-state-stop-title");
const DELAYED_OMP = join(DATA, "delayed-resume-omp.sh");
mkdirSync(DATA, { recursive: true });
writeFileSync(
  DELAYED_OMP,
  `#!/bin/bash
resume=0
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then resume=1; fi
done
if [ "$resume" = 0 ]; then sleep 4; fi
exec "${REAL_OMP}" "$@"
`,
);
chmodSync(DELAYED_OMP, 0o755);

realTest.use({ ompBinary: DELAYED_OMP });
realTest.setTimeout(300_000);

async function waitForNewOmp(
  realApp: { ompProcesses(): readonly number[] },
  before: readonly number[],
) {
  await expect
    .poll(() => realApp.ompProcesses().find((pid) => !before.includes(pid)), { timeout: 30_000 })
    .toBeDefined();
  const fresh = realApp.ompProcesses().find((pid) => !before.includes(pid));
  if (fresh === undefined) throw new Error("The chat's omp process was not listed.");
  return fresh;
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

async function expectFailedOpen(page: Page): Promise<void> {
  await expect(page.getByText("This chat could not open", { exact: true })).toBeVisible();
  await expect(page.getByText(/omp stopped before the chat could start\./)).toBeVisible();
  await expect(page.getByText("Ready when you are", { exact: true })).toHaveCount(0);
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--background").trim());
  const isDark = await page
    .locator("html")
    .evaluate((element) => element.classList.contains("dark"));
  expect(background).toBe(isDark ? "oklch(20.96% .0166 268.85)" : "oklch(97.91% 0 0)");
}

realTest("a chat that stops while opening says it could not open", async ({ realApp }) => {
  await mkdirSync(DATA, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  const before = realApp.ompProcesses();
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  process.kill(await waitForNewOmp(realApp, before), "SIGKILL");
  await expectFailedOpen(page);

  await mkdirSync(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1775-empty-state-light.png"),
    fullPage: true,
  });

  await setTheme(page, true);
  await expectFailedOpen(page);
  await page.screenshot({
    path: join(screenshots, "fix-1775-empty-state-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectFailedOpen(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1775-empty-state-narrow.png"),
    fullPage: true,
  });
});
