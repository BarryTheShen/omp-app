/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/launch/launch-playground.tsx",
      "--outfile",
      "dist/launch-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for launch playground.");
  writeFileSync(
    join(DIST_ROOT, "launch-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp launch playground</title>
  </head>
  <body>
    <div id="launch-playground-root"></div>
    <script type="module" src="/launch-playground.js"></script>
  </body>
</html>
`,
  );
}

async function installStubWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class StubWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = StubWebSocket.CONNECTING;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { readonly data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        const browser = globalThis as typeof globalThis & {
          __stubSocketUrls?: string[];
          __stubSocketMode?: "accept" | "expired" | "down";
        };
        const requests = browser.__stubSocketUrls ?? [];
        requests.push(this.url);
        browser.__stubSocketUrls = requests;
        queueMicrotask(() => {
          const mode = browser.__stubSocketMode ?? "accept";
          if (mode === "expired") {
            this.readyState = StubWebSocket.CLOSED;
            this.onclose?.({ code: 4401, reason: "expired token" });
            return;
          }
          if (mode === "down") {
            this.readyState = StubWebSocket.CLOSED;
            this.onclose?.({ code: 1006, reason: "server unavailable" });
            return;
          }
          const token = new URL(this.url).searchParams.get("token");
          if (token !== "e2e-token") {
            this.readyState = StubWebSocket.CLOSED;
            this.onclose?.({ code: 1008, reason: "Invalid launch token" });
            return;
          }
          this.readyState = StubWebSocket.OPEN;
          this.onopen?.({});
        });
      }

      send(data: string): void {
        const frame = JSON.parse(data) as { type?: string };
        if (frame.type !== "hello") return;
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "welcome",
              protocol: "omp-app/1",
              instanceId: "u0-8-stub",
              serverVersion: "e2e",
              omp: null,
              capabilities: {},
            }),
          });
        });
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: "closed" });
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: StubWebSocket,
    });
  });
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("connects the shell with a fragment token and checks landmarks/focus order", async ({
  page,
}) => {
  await installStubWebSocket(page);
  await page.goto("/launch-playground.html#token=e2e-token");
  await expect(page.getByTestId("connection-status")).toContainText("connected");
  await expect(page).toHaveURL(/launch-playground\.html$/);
  const socketUrls = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __stubSocketUrls?: string[] }).__stubSocketUrls ?? [],
  );
  expect(socketUrls).toHaveLength(1);
  expect(socketUrls[0]).toBe(`ws://${new URL(page.url()).host}/ws?token=e2e-token`);

  const landmarks = await page
    .locator(
      "main, nav, aside, footer, [role='region'], [data-shell-region='transcript'], [data-shell-region='composer']",
    )
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")).filter(Boolean),
    );
  expect(landmarks).toEqual([
    "Sessions",
    "Conversation",
    "Conversation transcript",
    "Composer",
    "Panels",
    "Status",
  ]);

  const firstToggle = page.locator("button").first();
  await firstToggle.focus();
  await expect(firstToggle).toBeFocused();
  const focusStyle = await firstToggle.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(focusStyle.outline !== "none" || focusStyle.shadow !== "none").toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toBeVisible();

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "../../.data/screenshots/u0-8-connected.png", fullPage: true });
});

test("shows a no-token screen and never opens a WebSocket", async ({ page }) => {
  await installStubWebSocket(page);
  await page.goto("/launch-playground.html");
  await expect(page.getByRole("heading", { name: "Start omp-app to connect" })).toBeVisible();
  await expect(page.getByText(/launch token is supplied in the URL fragment/i)).toBeVisible();
  const socketUrls = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __stubSocketUrls?: string[] }).__stubSocketUrls ?? [],
  );
  expect(socketUrls).toEqual([]);
  await page.screenshot({ path: "../../.data/screenshots/u0-8-no-token.png", fullPage: true });
});
test("shows an expired-link screen for terminal unauthorized close without retrying", async ({
  page,
}) => {
  await installStubWebSocket(page);
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __stubSocketMode?: "expired" }).__stubSocketMode =
      "expired";
  });
  await page.goto("/launch-playground.html#token=e2e-token");
  await expect(page.getByRole("heading", { name: "This launch link has expired" })).toBeVisible();
  await expect(page.getByText(/Open the URL the app printed when it last started/i)).toBeVisible();
  await page.waitForTimeout(300);
  const socketUrls = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __stubSocketUrls?: string[] }).__stubSocketUrls ?? [],
  );
  expect(socketUrls).toHaveLength(1);
});

test("keeps retrying while the server is down, then connects without a reload", async ({
  page,
}) => {
  await installStubWebSocket(page);
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __stubSocketMode?: "down" }).__stubSocketMode = "down";
    // The path the server reported the last time this browser connected to it.
    window.localStorage.setItem("omp-app.log-file", "/home/user/.local/state/omp-app/omp-app.log");
  });
  await page.goto("/launch-playground.html#token=e2e-token");
  await expect(page.getByText(/Can't reach the app server at .* Retrying/i)).toBeVisible({
    timeout: 8_000,
  });
  // The screen says where the log is, so a crash leaves a trail to attach.
  const hint = page.locator("[data-log-hint='true']");
  await expect(hint).toContainText("omp-app logs");
  await expect(hint).toContainText("omp-app debug-report");
  await expect(hint).toContainText("/home/user/.local/state/omp-app/omp-app.log");
  await page.screenshot({ path: "../../.data/screenshots/u0-8-server-down.png", fullPage: true });
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __stubSocketMode?: "accept" }).__stubSocketMode = "accept";
  });
  await expect(page.getByTestId("connection-status")).toContainText("connected", {
    timeout: 8_000,
  });
});
