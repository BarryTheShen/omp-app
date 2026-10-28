/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { APP_TOKEN_STORAGE_KEY } from "../src/launch/token";
import { ensurePlaygroundBuilt } from "./playground-build";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D3/settings/e2e-playground.tsx",
      "--outdir",
      "dist/d3-5-settings",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the provider settings stylesheet.");
  writeFileSync(
    join(DIST_ROOT, "d3-5-settings.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/assets/${css}" /><link rel="icon" href="data:," /><script type="module" src="/d3-5-settings/e2e-playground.js"></script></head><body><div id="d3-5-settings-root"></div></body></html>`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

realTest("shows source-aware provider settings in real omp", async ({ realApp }) => {
  const page = await realApp.open();
  await startChat(page);
  await page.addInitScript(({ key, token }) => window.sessionStorage.setItem(key, token), {
    key: APP_TOKEN_STORAGE_KEY,
    token: realApp.token,
  });
  const playgroundUrl = new URL(page.url());
  playgroundUrl.pathname = "/d3-5-settings.html";
  playgroundUrl.search = "";
  playgroundUrl.hash = "";
  await page.goto(playgroundUrl.toString());

  // Every load of this page opens a new chat before it shows the panel, and that starts an omp.
  const panel = page.getByTestId("provider-settings-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("heading", { name: "Provider settings" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Fireworks" })).toBeVisible();
  await expect(page.getByText("Fireworks tier")).toBeVisible();
  const fireworksTier = page.getByRole("combobox", { name: "Fireworks tier" });
  await fireworksTier.selectOption("priority");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Applied")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Fireworks tier" })).toHaveValue("priority", {
    timeout: 60_000,
  });
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "d3-5-settings-light.png"), fullPage: true });

  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.add("dark"),
      { once: true },
    );
  });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByText("Fireworks tier")).toBeVisible({ timeout: 60_000 });
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  await page.screenshot({ path: join(screenshots, "d3-5-settings-dark.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Protocol" }).click();
  await expect(page.getByText("Kimi API format")).toBeVisible();
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "d3-5-settings-narrow.png"), fullPage: true });
  expect(realApp.problems).toEqual([]);
});
realTest("captures provider settings failure states", async ({ realApp }) => {
  const page = await realApp.open();
  const stateUrl = new URL(page.url());
  stateUrl.pathname = "/d3-5-settings.html";
  stateUrl.hash = "";
  const state = async (name: "error" | "save" | "conflict"): Promise<void> => {
    stateUrl.search = `?state=${name}`;
    await page.goto(stateUrl.toString());
    await expect(page.getByTestId("provider-settings-panel")).toBeVisible({ timeout: 15_000 });
  };
  mkdirSync(screenshots, { recursive: true });

  await state("error");
  await expect(page.getByText("The provider settings could not be read here.")).toBeVisible();
  await page.screenshot({
    path: join(screenshots, "d3-5-settings-error-light.png"),
    fullPage: true,
  });

  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.add("dark"),
      { once: true },
    );
  });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: join(screenshots, "d3-5-settings-error-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(screenshots, "d3-5-settings-error-narrow.png"),
    fullPage: true,
  });

  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.remove("dark"),
      { once: true },
    );
  });
  await state("save");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("The provider settings could not be saved here.")).toBeVisible();
  await page.screenshot({
    path: join(screenshots, "d3-5-settings-save-error-light.png"),
    fullPage: true,
  });

  await state("conflict");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings changed elsewhere")).toBeVisible();
  await page.screenshot({
    path: join(screenshots, "d3-5-settings-conflict-light.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
