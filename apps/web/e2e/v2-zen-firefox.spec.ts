import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { ENTER, FIREFOX, FirefoxDriver } from "./firefox";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * The Firefox and Zen extension (`apps/zen`) in a real Firefox, as the build server's test image has it: installed as about:debugging
 * would, its panel asks once for the app's address, pairs once with a one-time code (the extension keeps the key),
 * shows the chat for its tab, and the chat's tools read and click that tab, open a tab of their own and act on it, and
 * are refused any other tab. The panel is opened as a page of its own (`panel.html?tab=<id>`): WebDriver cannot reach
 * the sidebar, and the panel is the same page there.
 */
const ADDON_ID = "zen-panel@omp-app.dev";
/** The extension's address in this Firefox, fixed by a preference so the test can open its pages. */
const UUID = "6f0d3c2e-8a51-4b7e-9c44-2d1e5f7a9b03";
const PANEL = `moz-extension://${UUID}/panel.html`;
const ready = /^(Fake Model|Message omp)/;

/** A shop page and another one, on a port of their own. */
async function pages(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    if (request.url === "/other") {
      response.end(
        "<!doctype html><title>Other page</title><p>Nothing to buy here.</p><button>Next</button>",
      );
      return;
    }
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

/** The extension's id of the tab showing `path`, as its panel page asks Firefox. */
async function tabIdOf(firefox: FirefoxDriver, path: string): Promise<number> {
  return firefox.runAsync<number>(
    `const done = arguments[arguments.length - 1];
     browser.tabs.query({}).then((tabs) => done(tabs.find((tab) => (tab.url ?? "").endsWith(arguments[0]))?.id ?? -1));`,
    [path],
  );
}

/** Into the panel's frame of the app, once it is there. */
async function intoApp(firefox: FirefoxDriver): Promise<void> {
  await firefox.frame(null);
  const frame = await firefox.waitFor("the app's frame", () =>
    firefox.find('iframe[title="omp app"]'),
  );
  await firefox.frame(frame);
}

/** Sends a message from the panel's box, once the chat is ready. */
async function send(firefox: FirefoxDriver, text: string): Promise<void> {
  const box = await firefox.waitFor(
    "the chat's message box",
    async () => {
      const found = await firefox.find('textarea[aria-label="Message"]');
      if (found === null) return null;
      const placeholder = await firefox.run<string>(
        "return document.querySelector('textarea[aria-label=\"Message\"]').placeholder;",
      );
      return ready.test(placeholder) ? found : null;
    },
    120_000,
  );
  await firefox.type(box, `${text}${ENTER}`);
}

realTest.describe("new UI: the Firefox and Zen extension in a real Firefox", () => {
  realTest.skip(
    FIREFOX === null,
    "needs Firefox and geckodriver (OMP_APP_FIREFOX, as the build server's test image has them)",
  );
  realTest.setTimeout(300_000);

  realTest(
    "it pairs once, reads and clicks its own tab, acts on a tab it opened, and is refused any other tab",
    async ({ realApp }) => {
      execFileSync("bun", [resolve(APP_ROOT, "apps/zen/scripts/build.ts")], { stdio: "pipe" });
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

      const { origin, server } = await pages();
      const firefox = await FirefoxDriver.start({
        "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
      });
      try {
        expect(await firefox.installTemporaryAddon(resolve(APP_ROOT, "apps/zen/dist"))).toBe(
          ADDON_ID,
        );
        await firefox.goto(`${origin}/shop`);
        const shopTab = await firefox.windowHandle();
        await firefox.newTab();
        await firefox.goto(`${origin}/other`);
        await firefox.newTab();

        // The first open asks for the app's address.
        await firefox.openExtensionPage(PANEL);
        const field = await firefox.waitFor("the address field", () =>
          firefox.find('input[type="url"]'),
        );
        await firefox.type(field, app);
        await firefox.click(await firefox.waitFor("Save", () => firefox.button("Save")));
        await firefox.waitForText("Chat about this tab");

        // The panel of the shop's tab (the toolbar button's binding): it pairs once, with a one-time code.
        const shopId = await tabIdOf(firefox, "/shop");
        const otherId = await tabIdOf(firefox, "/other");
        expect(shopId).toBeGreaterThan(0);
        await firefox.openExtensionPage(`${PANEL}?tab=${shopId}`);
        await intoApp(firefox);
        await firefox.click(
          await firefox.waitFor(
            "Enter a code instead",
            () => firefox.button("Enter a code instead"),
            60_000,
          ),
        );
        await firefox.type(
          await firefox.waitFor("the code field", () =>
            firefox.find('input[autocomplete="one-time-code"]'),
          ),
          code,
        );
        await firefox.click(await firefox.waitFor("Pair", () => firefox.button("Pair")));
        const kept = await (async () => {
          await firefox.frame(null);
          return firefox.waitFor("the kept key", () =>
            firefox.runAsync<string | null>(
              `const done = arguments[arguments.length - 1];
               browser.storage.local.get("deviceKey").then((stored) => done(stored.deviceKey ?? null));`,
            ),
          );
        })();
        expect(kept.length).toBeGreaterThan(20);

        // Its tools read and click its own tab.
        await intoApp(firefox);
        await send(firefox, "call_tool read_page {}");
        await firefox.waitForText("Title: Test shop");
        await send(firefox, 'call_tool click {"text":"Add to cart"}');
        await firefox.waitForText("Clicked button “Add to cart”");

        // Any other tab is refused; a tab it opened is its own.
        await send(firefox, `call_tool click {"tab":${otherId},"text":"Next"}`);
        await firefox.waitForText("acts only on its own tab");
        await send(firefox, `call_tool open_tab {"url":"${origin}/other"}`);
        const opened = await firefox.waitForText("in the background at");
        const ownedId = Number(/Opened tab (\d+)/.exec(opened)?.[1]);
        expect(ownedId).toBeGreaterThan(0);
        await send(firefox, `call_tool read_page {"tab":${ownedId}}`);
        await firefox.waitForText("Title: Other page");

        // A load later the panel signs in with the kept key and reopens its chat.
        await firefox.frame(null);
        await firefox.openExtensionPage(`${PANEL}?tab=${shopId}`);
        await intoApp(firefox);
        await firefox.waitForText("Title: Other page");
        expect(await firefox.bodyText()).not.toContain("Pair this device");

        await firefox.frame(null);
        await firefox.switchToWindow(shopTab);
        expect(await firefox.run<number>("return window.bought ?? 0;")).toBe(1);
      } finally {
        await firefox.close();
        server.closeAllConnections();
        server.close();
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
