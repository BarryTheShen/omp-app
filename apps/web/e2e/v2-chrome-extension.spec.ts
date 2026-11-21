import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * The browser extension's Chrome and Edge build (`apps/zen`, `bun scripts/build.ts --chrome`) in a real Google Chrome:
 * loaded unpacked, as chrome://extensions → Load unpacked would, its panel asks once for the app's address, pairs once
 * with a one-time code, and its chat's tools read and click the tab in front. The panel is opened as a page of its own
 * in a window of its own, serving the tabs' window (`panel.html?window=`), as the Firefox test does: a test cannot
 * reach the side panel, and the panel is the same page there.
 */

/**
 * Google Chrome takes no unpacked extension from its command line (Chrome 137 and later); it loads one through its
 * DevTools protocol (`Extensions.loadUnpacked`) when started with `--enable-unsafe-extension-debugging`, as Puppeteer
 * does. So the test starts Chrome itself, with remote debugging, and connects to it.
 */
async function chromeWithExtension(
  profile: string,
): Promise<{ cdp: Browser; chrome: ChildProcess }> {
  const binary = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find((path) =>
    existsSync(path),
  );
  if (binary === undefined) throw new Error("Google Chrome is not installed here.");
  const chrome = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      // The test image has no setuid sandbox helper, as Playwright's own launches there assume (chromiumSandbox off).
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((done, fail) => {
    let said = "";
    const timer = setTimeout(
      () => fail(new Error(`Chrome gave no DevTools address: ${said}`)),
      30_000,
    );
    chrome.stderr?.on("data", (chunk: Buffer) => {
      said += chunk.toString();
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (found?.[1] !== undefined) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    chrome.once("exit", (code) => fail(new Error(`Chrome ended (${code}): ${said}`)));
  });
  return { cdp: await chromium.connectOverCDP(endpoint), chrome };
}

async function shop(): Promise<{ origin: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><title>Test shop</title>
<h1>Shoes</h1>
<p>Winter boots, size 44, in stock.</p>
<button onclick="window.bought = (window.bought ?? 0) + 1">Add to cart</button>`);
  });
  const port = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { origin: `http://127.0.0.1:${port}`, server };
}

/** Chrome's extension APIs as the panel's page sees them, for the few calls the test makes there. */
interface ChromeApi {
  readonly tabs: {
    query(info: object): Promise<{ id?: number; windowId: number; url?: string }[]>;
  };
  readonly windows: { create(info: { url: string; focused?: boolean }): Promise<unknown> };
  readonly storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
}

const send = async (panel: Page, text: string): Promise<void> => {
  const box = panel.frameLocator("iframe").getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
};

realTest.describe("the browser extension in Chrome", () => {
  realTest.setTimeout(300_000);

  realTest(
    "its panel asks for the address, pairs once, and its tools read and click the tab in front",
    async ({ realApp }) => {
      execFileSync("bun", [resolve(APP_ROOT, "apps/zen/scripts/build.ts"), "--chrome"], {
        stdio: "pipe",
      });
      const extension = resolve(APP_ROOT, "apps/zen/dist-chrome");
      const owner = await realApp.open({ path: "/" });
      const app = new URL(owner.url()).origin;
      await owner.getByRole("button", { name: "Settings", exact: true }).click();
      const devices = owner.getByRole("region", { name: "Devices" });
      await devices.getByRole("button", { name: "Pair a new device" }).click();
      const shown = devices
        .getByRole("region", { name: "One-time code" })
        .getByText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      await expect(shown).toBeVisible();
      const code = (await shown.textContent()) ?? "";

      const pages = await shop();
      const profile = mkdtempSync(join(tmpdir(), "omp-chrome-ext-"));
      const { cdp, chrome } = await chromeWithExtension(profile);
      try {
        const session = await cdp.newBrowserCDPSession();
        const loaded = (await session.send(
          "Extensions.loadUnpacked" as never,
          { path: extension } as never,
        )) as {
          id: string;
        };
        const id = loaded.id;
        const browser = cdp.contexts()[0];
        if (browser === undefined) throw new Error("Chrome has no default context");
        const worker =
          browser.serviceWorkers().find((each) => each.url().includes(id)) ??
          (await browser.waitForEvent("serviceworker", (each) => each.url().includes(id)));
        const tab = browser.pages()[0] ?? (await browser.newPage());
        await tab.goto(`${pages.origin}/shop`);

        // The first open asks for the app's address.
        const setup = await browser.newPage();
        await setup.goto(`chrome-extension://${id}/panel.html`);
        await setup.getByRole("textbox", { name: "omp app's address" }).fill(app);
        await setup.getByRole("button", { name: "Save" }).click();

        // The panel of the shop's window, in a window of its own (as the side panel is beside the tabs, not one of them).
        const shopWindow = await setup.evaluate(async (path) => {
          const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
          const tabs = await api.tabs.query({});
          return tabs.find((each) => each.url?.endsWith(path))?.windowId ?? -1;
        }, "/shop");
        expect(shopWindow).toBeGreaterThan(0);
        await setup.close();
        await tab.bringToFront();
        const opened = browser.waitForEvent("page");
        await worker.evaluate(
          (url) =>
            (globalThis as unknown as { chrome: ChromeApi }).chrome.windows.create({
              url,
              focused: false,
            }),
          `chrome-extension://${id}/panel.html?window=${shopWindow}`,
        );
        const panel = await opened;
        const frame = panel.frameLocator("iframe");
        await frame
          .getByRole("button", { name: "Enter a code instead" })
          .click({ timeout: 90_000 });
        await frame.locator('input[autocomplete="one-time-code"]').fill(code);
        await frame.getByRole("button", { name: "Pair", exact: true }).click();
        await expect
          .poll(
            () =>
              panel.evaluate(async () => {
                const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
                return typeof (await api.storage.local.get("deviceKey")).deviceKey;
              }),
            { timeout: 60_000 },
          )
          .toBe("string");

        // The chat is pointed at the tab in front: its tools read and click it.
        await expect(frame.getByRole("textbox", { name: "Message" })).toBeVisible({
          timeout: 90_000,
        });
        await send(panel, "call_tool read_page {}");
        await expect(frame.getByText("Title: Test shop", { exact: false }).first()).toBeVisible({
          timeout: 60_000,
        });
        await send(panel, 'call_tool click {"text":"Add to cart"}');
        await expect(
          frame.getByText("Clicked button “Add to cart”", { exact: false }).first(),
        ).toBeVisible({
          timeout: 60_000,
        });
        expect(await tab.evaluate(() => (window as unknown as { bought?: number }).bought)).toBe(1);
      } finally {
        await cdp.close().catch(() => undefined);
        // Chrome writes its profile until it has ended: the folder goes after that.
        const ended = new Promise((done) => chrome.once("exit", done));
        chrome.kill();
        await Promise.race([ended, new Promise((done) => setTimeout(done, 5_000))]);
        pages.server.close();
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  );
});
