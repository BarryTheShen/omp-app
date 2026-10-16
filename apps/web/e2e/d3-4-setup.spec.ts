/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { APP_TOKEN_STORAGE_KEY } from "../src/launch/token";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D3/setup/e2e-playground.tsx",
      "--outdir",
      "dist/d3-4-setup",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the setup stylesheet.");
  writeFileSync(
    join(DIST_ROOT, "d3-4-setup.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/assets/${css}" /><link rel="icon" href="data:," /><script type="module" src="/d3-4-setup/e2e-playground.js"></script></head>
<body><div id="d3-4-setup-root"></div></body></html>`,
  );
}

test.beforeAll(() => buildPlaygroundPage());

realTest("gates terminal-only provider setup in real omp", async ({ realApp }) => {
  const page = await realApp.open();
  await startChat(page);
  await page.addInitScript(({ key, token }) => window.sessionStorage.setItem(key, token), {
    key: APP_TOKEN_STORAGE_KEY,
    token: realApp.token,
  });
  let setupCommandCalls = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = typeof payload === "string" ? payload : payload.toString("utf8");
      if (frame.includes('"port":"A1.ompCommandGateway"') && frame.includes('"method":"run"')) {
        setupCommandCalls += 1;
      }
    });
  });
  const playgroundUrl = new URL(page.url());
  playgroundUrl.pathname = "/d3-4-setup.html";
  playgroundUrl.search = "";
  playgroundUrl.hash = "";
  await page.goto(playgroundUrl.toString());
  await expect(page.getByRole("heading", { name: "Provider setup" })).toBeVisible();
  await expect(page.getByText("omp can only open provider setup in its terminal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run setup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set up providers" })).toBeDisabled();
  await expect(page.getByText("omp only offers the setup wizard in its terminal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open setup wizard" })).toBeDisabled();
  expect(setupCommandCalls).toBe(0);
  const panel = page.getByRole("region", { name: "Provider setup" });
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  mkdirSync(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "d3-4-setup-light.png"), fullPage: true });

  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.add("dark"),
      { once: true },
    );
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Provider setup" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "d3-4-setup-dark.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Set up providers" })).toBeDisabled();
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "d3-4-setup-narrow.png"), fullPage: true });

  expect(setupCommandCalls).toBe(0);
  expect(realApp.problems).toEqual([]);
});
