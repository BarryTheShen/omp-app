import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** The connection dot in the sidebar's foot, by the state it says. */
const dot = (page: Page, words: string) =>
  page.getByRole("button", { name: `Connection: ${words}`, exact: true });

/** Every state the dot has said since this was called, in order, without repeats. */
async function recordDot(page: Page): Promise<() => Promise<readonly string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { dotSeen: string[] }).dotSeen = seen;
    const read = (): void => {
      const label =
        document.querySelector('[data-tour="connection"]')?.getAttribute("aria-label") ?? "";
      if (label !== "" && seen.at(-1) !== label) seen.push(label);
    };
    read();
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  });
  return () => page.evaluate(() => (window as unknown as { dotSeen: string[] }).dotSeen);
}

/** The connection indicator and the link check (#2789). */
realTest.describe("new UI: the connection to the app", () => {
  realTest.setTimeout(180_000);

  realTest(
    "the dot says reconnecting while the server is away, through tries that fail, and connected again",
    async ({ realApp }) => {
      realApp.allowProblem(/WebSocket/i);
      let connections = 0;
      let refuse = 0;
      let first: WebSocketRoute | null = null;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            connections += 1;
            // The server is away: a try is turned away as soon as it is made.
            if (refuse > 0) {
              refuse -= 1;
              void socket.close({ code: 1001, reason: "going away" });
              return;
            }
            if (first === null) first = socket;
            socket.connectToServer();
          }),
      });
      await expect(dot(page, "Connected")).toBeVisible({ timeout: 60_000 });
      const seen = await recordDot(page);
      // The link drops, and the next two tries fail before one gets through.
      refuse = 2;
      await (first as WebSocketRoute | null)?.close({ code: 1001, reason: "going away" });
      await expect(dot(page, "Connected")).toBeVisible({ timeout: 60_000 });
      expect(connections).toBe(4);
      expect(await seen()).toEqual([
        "Connection: Connected",
        "Connection: Reconnecting…",
        "Connection: Connected",
      ]);
    },
  );

  realTest(
    "a link that stops answering is dropped for a new one, and Reconnect now is offered meanwhile",
    async ({ realApp }) => {
      let connections = 0;
      let silent = false;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            connections += 1;
            const number = connections;
            const held: (string | Buffer)[] = [];
            let server: WebSocketRoute | null = null;
            const join = (): void => {
              const joined = socket.connectToServer();
              server = joined;
              // The first link goes quiet on cue: nothing from the server reaches the page any more.
              joined.onMessage((message) => {
                if (!(silent && number === 1)) socket.send(message);
              });
              for (const message of held) joined.send(message);
            };
            socket.onMessage((message) => {
              if (server === null) held.push(message);
              else server.send(message);
            });
            // A new link takes a few seconds to reach the server, so its state can be seen meanwhile.
            if (number === 1) join();
            else setTimeout(join, 4_000);
          }),
      });
      await expect(dot(page, "Connected")).toBeVisible({ timeout: 60_000 });
      silent = true;
      // Back online: the page checks its link at once.
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(dot(page, "Reconnecting…")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Reconnect now" })).toBeVisible();
      await expect(dot(page, "Connected")).toBeVisible({ timeout: 30_000 });
      expect(connections).toBe(2);
      expect(realApp.problems).toEqual([]);
    },
  );
});
