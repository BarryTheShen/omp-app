import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { ENTER, FIREFOX, FirefoxDriver } from "./firefox";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * The Firefox and Zen extension (`apps/zen`) in a real Firefox, as the build server's test image has it: installed as
 * about:debugging would, its panel asks once for the app's address, pairs once with a one-time code (the extension keeps
 * the key), and is one panel for the window: its chat is pointed at the tab in front, follows another tab brought to the
 * front without loading again, keeps a running reply on the tab it began on, and its tools act on that tab and on tabs
 * it opened, never another. The panel is opened as a page of its own, serving the tabs' window (`panel.html?window=`):
 * WebDriver cannot reach the sidebar, and the panel is the same page there.
 */
const ADDON_ID = "zen-panel@omp-app.dev";
/** The extension's address in this Firefox, fixed by a preference so the test can open its pages. */
const UUID = "6f0d3c2e-8a51-4b7e-9c44-2d1e5f7a9b03";
const PANEL = `moz-extension://${UUID}/panel.html`;
const ready = /^(Fake Model|Message omp)/;

/** Pages on a port of their own, each with a title of its own; the shop's button counts its clicks. */
const TITLES: Record<string, string> = {
  "/other": "Other page",
  "/third": "Third page",
  "/fourth": "Fourth page",
  "/owned": "Owned page",
};
async function pages(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    const title = TITLES[request.url ?? ""];
    if (title !== undefined) {
      response.end(
        `<!doctype html><title>${title}</title><p>Nothing to buy here.</p><button>Next</button>`,
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

/** The extension's id of the tab showing `path` and of its window, as its panel page asks Firefox. */
async function tabOf(
  firefox: FirefoxDriver,
  path: string,
): Promise<{ id: number; window: number }> {
  return firefox.runAsync<{ id: number; window: number }>(
    `const done = arguments[arguments.length - 1];
     browser.tabs.query({}).then((tabs) => {
       const tab = tabs.find((each) => (each.url ?? "").endsWith(arguments[0]));
       done({ id: tab?.id ?? -1, window: tab?.windowId ?? -1 });
     });`,
    [path],
  );
}

/** Inside the app's frame: waits until the chip above the box names the tab in front. */
async function chipNames(firefox: FirefoxDriver, title: string): Promise<void> {
  await firefox.waitFor(
    `the chip naming “${title}”`,
    async () =>
      (
        await firefox.run<string>(
          "return document.querySelector('[data-tour=\"embed-context\"]')?.textContent ?? '';",
        )
      ).includes(title)
        ? true
        : null,
    30_000,
  );
}

/** Brings a tab to the front of its window, as clicking it would, and goes back to the panel's frame of the app. */
async function bringToFront(firefox: FirefoxDriver, tab: string, panel: string): Promise<void> {
  await firefox.frame(null);
  await firefox.switchToWindow(tab);
  await firefox.switchToWindow(panel);
  await intoApp(firefox);
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
    "one panel for the window: it pairs once, follows the tab in front without loading again, keeps a running reply on its tab, and is refused any other",
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
        const handles: Record<string, string> = {};
        for (const path of ["/other", "/third", "/fourth"]) {
          await firefox.newTab();
          await firefox.goto(`${origin}${path}`);
          handles[path] = await firefox.windowHandle();
        }
        // The shop's tab is in front of its window, and the panel's pages open in a window of their own, serving the
        // tabs' window: the sidebar is beside the tabs and not one of them.
        await firefox.switchToWindow(shopTab);
        const panelTab = await firefox.newWindow();

        // The first open asks for the app's address.
        await firefox.openExtensionPage(PANEL);
        const field = await firefox.waitFor("the address field", () =>
          firefox.find('input[type="url"]'),
        );
        await firefox.type(field, app);
        await firefox.click(await firefox.waitFor("Save", () => firefox.button("Save")));
        await intoApp(firefox);

        // The panel of the tabs' window: it pairs once, with a one-time code.
        await firefox.frame(null);
        const shop = await tabOf(firefox, "/shop");
        const other = await tabOf(firefox, "/other");
        expect(shop.id).toBeGreaterThan(0);
        const served = `${PANEL}?window=${shop.window}`;
        await firefox.openExtensionPage(served);
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

        // The chat is pointed at the tab in front: its tools read and click it.
        await intoApp(firefox);
        await chipNames(firefox, "Test shop");
        await send(firefox, "call_tool read_page {}");
        await firefox.waitForText("Title: Test shop");
        await send(firefox, 'call_tool click {"text":"Add to cart"}');
        await firefox.waitForText("Clicked button “Add to cart”");

        // Any other tab is refused; a tab it opened is its own.
        await send(firefox, `call_tool click {"tab":${other.id},"text":"Next"}`);
        await firefox.waitForText("acts only on the tab in front");
        await send(firefox, `call_tool open_tab {"url":"${origin}/owned"}`);
        const opened = await firefox.waitForText("in the background at");
        const ownedId = Number(/Opened tab (\d+)/.exec(opened)?.[1]);
        expect(ownedId).toBeGreaterThan(0);
        await send(firefox, `call_tool read_page {"tab":${ownedId}}`);
        await firefox.waitForText("Title: Owned page");

        // Another tab comes to the front: the same panel, not loaded again, with the same chat, pointed at that tab.
        await firefox.frame(null);
        await firefox.run<void>("window.__stayed = true;");
        const frameAddress = await firefox.run<string>(
          "return document.querySelector('iframe[title=\"omp app\"]').src;",
        );
        const otherTab = handles["/other"] ?? "";
        await bringToFront(firefox, otherTab, panelTab);
        await chipNames(firefox, "Other page");
        await firefox.frame(null);
        expect(await firefox.run<boolean>("return window.__stayed === true;")).toBe(true);
        expect(
          await firefox.run<string>(
            "return document.querySelector('iframe[title=\"omp app\"]').src;",
          ),
        ).toBe(frameAddress);
        await intoApp(firefox);
        await firefox.waitForText("Title: Owned page");
        await send(firefox, "call_tool read_page {}");
        await firefox.waitForText("Title: Other page");

        // A reply keeps the tab that was in front when it began: the tab brought to the front while it runs is not
        // acted on, and the next message, sent from there, is.
        await bringToFront(firefox, handles["/third"] ?? "", panelTab);
        await chipNames(firefox, "Third page");
        await send(
          firefox,
          'call_tools wait_for_text {"text":"never on this page","timeout_ms":4000} then read_page {}',
        );
        await bringToFront(firefox, handles["/fourth"] ?? "", panelTab);
        await chipNames(firefox, "Fourth page");
        await firefox.waitForText("both calls done", 60_000);
        await firefox.waitForText("Title: Third page");
        expect(await firefox.bodyText()).not.toContain("Title: Fourth page");
        await send(firefox, "call_tool read_page {}");
        await firefox.waitForText("Title: Fourth page");

        // A load later the panel signs in with the kept key and reopens the window's chat.
        await firefox.frame(null);
        await firefox.openExtensionPage(served);
        await intoApp(firefox);
        await firefox.waitForText("Title: Fourth page");
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
