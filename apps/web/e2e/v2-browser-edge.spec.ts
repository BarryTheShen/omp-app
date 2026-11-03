import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startNewChat } from "./real-omp";

/**
 * "Your Edge" (Browser and relay control, B5-B7) on the real server: choosing it runs omp's relay in the app's server and
 * sets omp's `browser.relay`; the panel shows the link to run on the laptop until the browser connects; a stand-in for
 * Edge's relay extension (the test's own WebSocket on the relay's `/ext`, speaking omp's relay protocol: it says hello
 * with one tab and answers every request) connects, and the panel lists its tab; the choice turns itself off after its
 * time (9 seconds here). The relay listens on its usual port, 9224: one test at a time.
 */
realTest.use({ serverEnv: { OMP_APP_EDGE_MINUTES: "0.15" } });

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

realTest.describe("new UI: Your Edge, through omp's relay", () => {
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
    "Your Edge waits with the laptop's link, lists the browser's tabs once its extension connects, and turns itself off",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      const choice = panel(page).getByRole("group", { name: "Chats use" });
      await choice.getByRole("button", { name: "Your Edge" }).click();
      const section = panel(page).getByRole("region", { name: "Your Edge" });
      await expect(section).toContainText("Waiting for your Edge", { timeout: 30_000 });
      await expect(section.locator("code")).toContainText("ssh -N -L 9224:127.0.0.1:9224 ");
      await expect(section).toContainText("Turns itself off at");
      const settings = () => readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(() => "");
      await expect.poll(settings).toMatch(/relay: true/);
      await page.screenshot({ path: join(screenshots, "browser-edge-waiting.png") });

      extension = await standInExtension();
      await expect(section).toContainText("Connected: Edge 151.", { timeout: 30_000 });
      await expect(section.getByRole("list", { name: "Its tabs" })).toContainText("Edge page");
      await page.screenshot({ path: join(screenshots, "browser-edge-connected.png") });

      // Its time runs out: the relay stops, the setting goes and the choice is the chats' own browser again.
      await expect(choice.getByRole("button", { name: "Their own browser" })).toHaveAttribute(
        "aria-pressed",
        "true",
        {
          timeout: 30_000,
        },
      );
      await expect(section).toHaveCount(0);
      await expect.poll(settings).not.toMatch(/relay: true/);
      expect(realApp.problems).toEqual([]);
    },
  );
});
