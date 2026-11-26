import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/**
 * "Your own browser" (Browser and relay control, B5-B7) on the real server: choosing it runs omp's relay in the app's
 * server and sets omp's `browser.relay`; on the app's own computer the panel says the browser joins once it runs with
 * omp's extension, until it connects; a stand-in for the relay extension (the test's own WebSocket on the relay's
 * `/ext`, speaking omp's relay protocol: it says hello with one tab and answers every request) connects, and the panel
 * lists its tab; the choice stays until another browser is chosen. The relay listens on its usual port, 9224: one test
 * at a time. From another computer a carrier brings the extension instead (`relay-carrier.test.ts`).
 */

const RELAY = "ws://127.0.0.1:9224/ext";

/** Edge's relay extension, as far as the relay sees it: hello with its tabs, then an answer to every request. */
function standInExtension(): Promise<WebSocket> {
  return new Promise((connected, failed) => {
    const socket = new WebSocket(RELAY);
    socket.onerror = () =>
      failed(new Error(`The relay at ${RELAY} refused the stand-in extension.`));
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          t: "hello",
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Edg/151.0.0.0",
          browserVersion: "Edg/151.0.3405.0",
          tabs: [
            {
              tabId: 7,
              url: "https://example.com/edge-page",
              title: "Edge page",
              active: true,
              discarded: false,
              windowId: 1,
              pinned: false,
              groupId: -1,
            },
          ],
          attachedTabIds: [],
          discardedTabsProtocol: 1,
          instanceId: "stand-in-edge",
          browserSession: "stand-in-run",
        }),
      );
      connected(socket);
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t: string; id?: number };
      if (message.t === "rpc")
        socket.send(JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} }));
    };
  });
}

realTest.describe("new UI: your own browser, through omp's relay", () => {
  realTest.setTimeout(180_000);
  let extension: WebSocket | null = null;
  realTest.afterEach(async ({ realApp }, testInfo) => {
    extension?.close();
    extension = null;
    if (testInfo.status !== testInfo.expectedStatus) {
      mkdirSync(screenshots, { recursive: true });
      writeFileSync(
        join(screenshots, `browser-edge-server-${testInfo.repeatEachIndex}.log`),
        realApp.log(),
      );
    }
  });

  const panel = (page: Page) =>
    page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: "Browser", exact: true });

  realTest(
    "Your own browser waits for the browser, lists its tabs once it connects, and stays until another browser is chosen",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      const choice = panel(page).getByRole("group", { name: "Chats use" });
      await choice.getByRole("button", { name: "Your own browser" }).click();
      // Chosen at once, while the relay starts (seconds): the choice does not wait for it, nor flick back.
      await expect(choice.getByRole("button", { name: "Your own browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 1_000 },
      );
      const section = panel(page).getByRole("region", { name: "Your own browser" });
      await expect(section).toContainText("Waiting for your browser", { timeout: 30_000 });
      // No ssh line and no account name: on the app's own computer, the browser joins through omp's extension.
      await expect(section).not.toContainText("ssh");
      await expect(section).toContainText("open Chrome or Edge with omp's extension");
      await expect(section).toContainText(
        "Chats use it until another browser is chosen here, or you stop.",
      );
      await expect(choice.getByRole("button", { name: "Your own browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const settings = () => readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(() => "");
      await expect.poll(settings).toMatch(/relay: true/);
      await page.screenshot({ path: join(screenshots, "browser-edge-waiting.png") });

      extension = await standInExtension();
      await expect(section).toContainText("Connected: Edge 151.", { timeout: 30_000 });
      await expect(section.getByRole("list", { name: "Its tabs" })).toContainText("Edge page");
      await page.screenshot({ path: join(screenshots, "browser-edge-connected.png") });

      // Another choice ends it: the relay stops, and the setting goes.
      await choice.getByRole("button", { name: "omp's hidden one" }).click();
      await expect(choice.getByRole("button", { name: "omp's hidden one" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(section).toHaveCount(0);
      await expect.poll(settings).not.toMatch(/relay: true/);

      // Chosen again, Stop using your browser ends it too: omp's hidden one is chosen, and the setting goes.
      await choice.getByRole("button", { name: "Your own browser" }).click();
      await expect.poll(settings).toMatch(/relay: true/);
      await section.getByRole("button", { name: "Stop using your browser" }).click();
      await expect(choice.getByRole("button", { name: "omp's hidden one" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(section).toHaveCount(0);
      await expect.poll(settings).not.toMatch(/relay: true/);
      expect(realApp.problems).toEqual([]);
    },
  );
});
