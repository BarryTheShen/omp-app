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

      // A new page takes the typing at once, like a browser's new tab: its address has the cursor, and what is typed
      // there opens in the new page while the first keeps its own.
      await panel(page).getByRole("button", { name: "New page" }).click();
      await expect(address).toBeFocused({ timeout: 15_000 });
      await page.keyboard.type(`http://127.0.0.1:${port}/again`);
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Test page" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel(page).getByRole("tab", { name: "typed:hello" })).toBeVisible();
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
