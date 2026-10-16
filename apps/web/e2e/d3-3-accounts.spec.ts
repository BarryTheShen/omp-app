/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { APP_TOKEN_STORAGE_KEY } from "../src/launch/token";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const maskedAccountLabel = ["a***", "example.test"].join("@");
const rawEmail = ["account", "example.test"].join("@");
const accessLeak = "t".repeat(32);
const refreshLeak = "r".repeat(32);
function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D3/accounts/e2e-playground.tsx",
      "--outdir",
      "dist/d3-3-accounts",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the account selector stylesheet.");
  writeFileSync(
    join(DIST_ROOT, "d3-3-accounts.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/assets/${css}" /><link rel="icon" href="data:," /><script type="module" src="/d3-3-accounts/e2e-playground.js"></script></head>
<body><div id="d3-3-accounts-root"></div></body></html>`,
  );
}

async function seedAccountDatabase(agentDir: string): Promise<void> {
  const dbPath = join(agentDir, "agent.db");
  mkdirSync(agentDir, { recursive: true });
  const seed = `import { Database } from "bun:sqlite";
const db = new Database(process.env.D3_ACCOUNT_DB);
db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)))");
db.run("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
const access = ["Bearer", "t".repeat(32)].join(" ");
const refresh = ["refresh", "r".repeat(32)].join("-");
const email = ["account", "example.test"].join("@");
db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run("provider-a", "oauth", JSON.stringify({ access, refresh, email, expiresAt: Date.now() + 60_000 }));
db.close();`;
  execFileSync("bun", ["-e", seed], {
    cwd: APP_ROOT,
    env: { ...process.env, D3_ACCOUNT_DB: dbPath },
    stdio: "inherit",
  });
}
test.beforeAll(() => buildPlaygroundPage());

realTest("lists and pins a redacted provider account through real omp", async ({ realApp }) => {
  const page = await realApp.open();
  await seedAccountDatabase(realApp.agentDir);
  await startChat(page);
  await page.addInitScript(({ key, token }) => window.sessionStorage.setItem(key, token), {
    key: APP_TOKEN_STORAGE_KEY,
    token: realApp.token,
  });
  const playgroundUrl = new URL(page.url());
  playgroundUrl.pathname = "/d3-3-accounts.html";
  playgroundUrl.search = "";
  playgroundUrl.hash = "";
  await page.goto(playgroundUrl.toString());
  await expect(page.getByRole("heading", { name: "Provider accounts" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Provider accounts" });
  mkdirSync(screenshots, { recursive: true });
  await expect(page.getByText(maskedAccountLabel)).toBeVisible();
  await expect(page.getByText("provider sign-in")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(accessLeak);
  await expect(page.locator("body")).not.toContainText(refreshLeak);
  await expect(page.locator("body")).not.toContainText(rawEmail);
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "d3-3-accounts-light.png"),
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
  await expect(page.getByText(maskedAccountLabel)).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "d3-3-accounts-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Use for this chat" })).toBeVisible();
  await expect(panel).toHaveCSS("background-color", /^(rgb|oklch)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "d3-3-accounts-narrow.png"),
    fullPage: true,
  });

  const selectAccount = page.getByRole("button", { name: maskedAccountLabel });
  await selectAccount.focus();
  await page.keyboard.press("Enter");
  await expect(selectAccount).toHaveAttribute("aria-current", "true");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(page.getByRole("button", { name: "Reset usage" })).toBeEnabled();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reset usage" }).click();
  await expect(page.getByRole("alert")).toContainText("can't reset usage");
  await expect(page.getByText(maskedAccountLabel)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Use for this chat" }).click();
  await expect(page.getByText(/provider sign-in.*active/)).toBeVisible();
  expect(realApp.problems).toEqual([]);
});
