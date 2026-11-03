import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/**
 * The app's own browser (Browser and relay control, B1-B3) on the real server: the Browser panel starts a Chrome on the
 * server's machine, an address typed opens the page, the page shows live in the panel, and a click and typed text in the
 * panel reach the page as its own input. The server finds the machine's Chrome itself, on a DevTools port it chooses.
 */
// The test containers cannot run Chrome's sandbox; the app's own machine does.
realTest.use({ serverEnv: { OMP_APP_BROWSER_PORT: "0", OMP_APP_BROWSER_NO_SANDBOX: "1" } });

const PAGE = `<!doctype html><title>Test page</title>
<style>html,body{margin:0;height:100%}button{position:fixed;left:0;top:0;width:100%;height:50%;font-size:32px}
input{position:fixed;left:0;top:60%;width:100%;height:30%;font-size:32px}</style>
<button onclick="document.title='clicked'">Press</button>
<form onsubmit="event.preventDefault();document.title='typed:'+document.querySelector('input').value"><input name="t"></form>`;

realTest.describe("new UI: the app's own browser", () => {
  realTest.setTimeout(240_000);
  let site: Server | null = null;
  /** Requests the test's site answered: none means the browser never asked for the page. */
  let served = 0;
  realTest.afterEach(async ({ realApp }, testInfo) => {
    // A failure keeps the server's own log beside the screenshots, and what Chrome itself says its tabs are.
    if (testInfo.status !== testInfo.expectedStatus) {
      mkdirSync(screenshots, { recursive: true });
      const name = `browser-server-${testInfo.title.slice(0, 30)}-${testInfo.repeatEachIndex}`;
      const log = realApp.log();
      writeFileSync(join(screenshots, `${name}.log`), log);
      const devtools = /browser\.started port=(\d+)/.exec(log)?.[1];
      const chrome = async (path: string) =>
        devtools === undefined
          ? "no browser.started line"
          : await fetch(`http://127.0.0.1:${devtools}${path}`)
              .then((response) => response.text())
              .catch((error: unknown) => String(error));
      writeFileSync(
        join(screenshots, `${name}.chrome.txt`),
        `served=${served}\n/json/version: ${await chrome("/json/version")}\n/json/list: ${await chrome("/json/list")}\n`,
      );
    }
    served = 0;
    const running = site;
    site = null;
    if (running === null) return;
    running.closeAllConnections();
    await new Promise<void>((done) => running.close(() => done()));
  });

  // The panel itself, in the side panel: the pane group around it is a region named for it too.
  const panel = (page: Page) =>
    page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: "Browser", exact: true });

  realTest(
    "the panel starts the browser, opens a typed address, shows the page live, and a click and typing reach it",
    async ({ realApp }) => {
      const started = createServer((_request, response) => {
        served += 1;
        response.setHeader("content-type", "text/html");
        response.end(PAGE);
      });
      site = started;
      await new Promise<void>((done) => started.listen(0, "127.0.0.1", done));
      const port = (started.address() as AddressInfo).port;

      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await panel(page).getByRole("button", { name: "Start the browser" }).click();
      await expect(panel(page).getByRole("tablist", { name: "Pages" })).toBeVisible({
        timeout: 60_000,
      });

      const address = panel(page).getByRole("textbox", { name: "Address" });
      await address.fill(`http://127.0.0.1:${port}/`);
      await address.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Test page" })).toBeVisible({
        timeout: 30_000,
      });
      const view = panel(page).getByRole("application", { name: /^Page: / });
      await expect(view.locator("img")).toBeVisible({ timeout: 30_000 });

      // A click on the page's button, in the panel's live view.
      const bounds = await view.boundingBox();
      if (bounds === null) throw new Error("no live view");
      await view.click({ position: { x: bounds.width / 2, y: bounds.height * 0.25 } });
      await expect(panel(page).getByRole("tab", { name: "clicked" })).toBeVisible({
        timeout: 15_000,
      });

      // A tap on its field, then text typed under the page, with Enter.
      await view.click({ position: { x: bounds.width / 2, y: bounds.height * 0.75 } });
      const typing = panel(page).getByRole("textbox", { name: "Type into the page" });
      await typing.fill("hello");
      await typing.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "typed:hello" })).toBeVisible({
        timeout: 15_000,
      });

      // Text copied on this device (from a password manager, say) is pasted into the page with Ctrl+V on the live view:
      // the key is not sent to the page, whose own paste would read the clipboard of the server's machine.
      await address.fill("pasted-secret");
      await address.selectText();
      await page.keyboard.press("Control+c");
      await view.click({ position: { x: bounds.width / 2, y: bounds.height * 0.75 } });
      await page.keyboard.press("Control+v");
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("tab", { name: /^typed:.*pasted-secret$/ })).toBeVisible({
        timeout: 15_000,
      });

      // A new page takes the typing at once, like a browser's new tab: the press puts the cursor in its empty address,
      // and what is typed there, Enter included, opens in the new page while the first keeps its own.
      await panel(page).getByRole("button", { name: "New page" }).click();
      await page.keyboard.type(`http://127.0.0.1:${port}/again`);
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Test page" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel(page).getByRole("tab", { name: "typed:hello" })).toBeVisible();
      await expect(panel(page).getByRole("tab")).toHaveCount(2);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the panel shows the tab the browser has in front, opened again or when a chat opens a page, and a click reaches it",
    async ({ realApp }) => {
      // Pages that say which they are, and that they were clicked.
      const started = createServer((request, response) => {
        served += 1;
        const title = `Page ${(request.url ?? "/").slice(1)}`;
        response.setHeader("content-type", "text/html");
        response.end(
          `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%}button{position:fixed;inset:0;font-size:32px}</style><button onclick="document.title='${title} clicked'">Press</button>`,
        );
      });
      site = started;
      await new Promise<void>((done) => started.listen(0, "127.0.0.1", done));
      const port = (started.address() as AddressInfo).port;

      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await panel(page).getByRole("button", { name: "Start the browser" }).click();
      const address = panel(page).getByRole("textbox", { name: "Address" });
      await expect(address).toBeVisible({ timeout: 60_000 });
      await address.fill(`http://127.0.0.1:${port}/one`);
      await address.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Page one" })).toBeVisible({
        timeout: 30_000,
      });
      await panel(page).getByRole("button", { name: "New page" }).click();
      await page.keyboard.type(`http://127.0.0.1:${port}/two`);
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Page two" })).toBeVisible({
        timeout: 30_000,
      });

      // The app opened again: its panel shows page two, which the browser has in front (page one is first in the
      // list, behind it, where the page neither draws nor takes a click), and a click on it reaches the page.
      await page.reload();
      const shown = panel(page).getByRole("tab", { selected: true });
      await expect(shown).toHaveAccessibleName("Page two", { timeout: 60_000 });
      const view = panel(page).getByRole("application", { name: /^Page: / });
      await expect(view.locator("img")).toBeVisible({ timeout: 30_000 });
      await view.click();
      await expect(shown).toHaveAccessibleName("Page two clicked", { timeout: 15_000 });

      // A page a chat opens (here through the browser's own DevTools address, as omp's browser tool does) comes to the
      // front, and the panel follows it.
      const devtools = /browser\.started port=(\d+)/.exec(realApp.log())?.[1];
      if (devtools === undefined) throw new Error("the server logged no started browser");
      const opened = await fetch(
        `http://127.0.0.1:${devtools}/json/new?http://127.0.0.1:${port}/three`,
        { method: "PUT" },
      );
      expect(opened.ok).toBe(true);
      await expect(shown).toHaveAccessibleName("Page three", { timeout: 30_000 });
      await expect(view.locator("img")).toBeVisible({ timeout: 30_000 });
      await view.click();
      await expect(shown).toHaveAccessibleName("Page three clicked", { timeout: 15_000 });

      // A click on page one's tab brings it to the front; a click in it reaches it.
      await panel(page).getByRole("tab", { name: "Page one" }).click();
      await expect(shown).toHaveAccessibleName("Page one");
      await view.click();
      await expect(shown).toHaveAccessibleName("Page one clicked", { timeout: 15_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "This browser makes it the one chats use (omp's browser.cdpUrl, every folder); Their own browser takes that out",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      const choice = panel(page).getByRole("group", { name: "Chats use" });
      await expect(choice.getByRole("button", { name: "Their own browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await choice.getByRole("button", { name: "This browser" }).click();
      await expect(choice.getByRole("button", { name: "This browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 60_000 },
      );
      // The browser started for it, and omp's settings for every folder name its address.
      await expect(panel(page).getByRole("tablist", { name: "Pages" })).toBeVisible();
      const settings = () => readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(() => "");
      await expect.poll(settings).toMatch(/cdpUrl: http:\/\/127\.0\.0\.1:\d+/);

      await choice.getByRole("button", { name: "Their own browser" }).click();
      await expect(choice.getByRole("button", { name: "Their own browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect.poll(settings).not.toMatch(/cdpUrl:/);
      expect(realApp.problems).toEqual([]);
    },
  );
});
