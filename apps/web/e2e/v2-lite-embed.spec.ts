import { createServer, type Server } from "node:http";
import type { WebSocketRoute } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** Ends the host page's server and its open connections, so a repeat of the test can take its port again. */
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * The embed protocol, on real omp: a page that frames the lite view (a browser extension's panel, an editor's webview)
 * says hello with its settings, what it has open and a tool. The panel greets as the host asks, shows what goes with each
 * message and lets you leave it out; the chat gets the host's tool, and the fake model's call of it reaches the host page,
 * whose answer reaches the chat.
 */
const HOST_PORT = 41_000 + Math.floor(Math.random() * 20_000);
const HOST_APP = `http://127.0.0.1:${HOST_PORT}`;
const ready = /^(Fake Model|Message omp)/;

/**
 * The host page: frames the panel, answers its `listening` with a hello, and answers each call of its tool. `vscode`:
 * the frame is sandboxed as VS Code's webview is (no window may open from it), and the page opens what the panel asks
 * it to open (`open`), keeps the address, and says so (`opened`). `chat`: the panel opens that chat (`?chat=`), as a
 * panel loaded again opens the chat it had.
 */
function hostPage(app: string, token: string, vscode = false, chat?: string): string {
  const script = `
const frame = document.querySelector("iframe");
const app = ${JSON.stringify(app)};
window.calls = [];
window.ready = [];
window.opens = [];
const send = (message) => frame.contentWindow.postMessage({ omp: "embed", v: 1, ...message }, app);
window.setContext = (context) => send({ type: "context", context });
window.addEventListener("message", (event) => {
  if (event.origin !== app || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (message === null || typeof message !== "object" || message.omp !== "embed") return;
  if (message.type === "listening") {
    send({
      type: "hello",
      host: "testhost",
      settings: { greeting: "Hello from the host" },
      context: { kind: "page", title: "Host page title", uri: "https://example.com/doc", selection: "the selected words" },
      tools: [{ name: "page_title", description: "Says the title of the page the host shows", parameters: { type: "object", properties: {} } }],
    });
  }
  if (message.type === "ready") window.ready.push(message);
  if (message.type === "tool_call") {
    window.calls.push(message);
    send({ type: "tool_result", callId: message.callId, result: { content: [{ type: "text", text: "host title: Host page title" }] } });
  }
  if (message.type === "open" && ${vscode}) {
    window.opens.push(message.url);
    send({ type: "opened", url: message.url });
  }
});`;
  const sandbox = vscode
    ? ' sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"'
    : "";
  const asked = chat === undefined ? "" : `?chat=${encodeURIComponent(chat)}`;
  return `<!doctype html><title>host</title><iframe title="omp"${sandbox} style="width:420px;height:760px;border:0" src="${app}/lite${asked}#token=${encodeURIComponent(token)}"></iframe><script>${script}</script>`;
}

realTest.describe("new UI lite view framed by a host that speaks the embed protocol", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: HOST_APP } });

  realTest(
    "the host's greeting and what it has open show; its tool is the chat's and its answer comes back; what is open can be left out",
    async ({ realApp, browser }) => {
      const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(hostPage(app, realApp.token));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(HOST_PORT, "127.0.0.1", resolve);
      });
      const context = await browser.newContext();
      try {
        const host = await context.newPage();
        await host.goto(`${HOST_APP}/doc`);
        const panel = host.frameLocator('iframe[title="omp"]');
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        await expect(panel.getByText("Hello from the host")).toBeVisible({ timeout: 30_000 });
        const sentWith = panel.getByRole("region", {
          name: "Sent with your messages, from testhost",
        });
        await expect(sentWith).toContainText("A selection on Host page title");
        // The chat took the host's tool, and said so.
        await expect
          .poll(() =>
            host.evaluate(
              () => (window as unknown as { ready: { tools: string[] }[] }).ready.at(-1)?.tools,
            ),
          )
          .toEqual(["page_title"]);

        await box.fill("call_tool page_title {}");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: host title: Host page title")).toBeVisible({
          timeout: 60_000,
        });
        expect(
          await host.evaluate(() =>
            (window as unknown as { calls: { name: string }[] }).calls.map((call) => call.name),
          ),
        ).toEqual(["page_title"]);
        // The message shows what was typed, and what went with it as a chip, not the block.
        const transcript = panel.getByRole("region", { name: "Transcript" });
        await expect(transcript.getByText("call_tool page_title {}")).toBeVisible();
        await expect(
          transcript.getByRole("list", { name: "Sent with what was open in testhost" }),
        ).toContainText("A selection on Host page title");
        await expect(transcript.getByText("<host-context", { exact: false })).toHaveCount(0);

        // Left out, it goes with no message until the host says something else is open.
        await sentWith.getByRole("button", { name: "Don't send this" }).click();
        await expect(sentWith).toBeHidden();
        await box.fill("count_reply leftout");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText(/count-\d+ leftout/)).toBeVisible({ timeout: 60_000 });
        await expect(
          transcript.getByRole("list", { name: "Sent with what was open in testhost" }),
        ).toHaveCount(1);
        await host.evaluate(() =>
          (window as unknown as { setContext: (context: unknown) => void }).setContext({
            kind: "page",
            title: "Another page",
          }),
        );
        await expect(sentWith).toContainText("Looking at Another page");
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "after the panel's link drops and comes back, the chat has the host's tool again and its call reaches the host",
    async ({ realApp, browser }) => {
      const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(hostPage(app, realApp.token));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(HOST_PORT, "127.0.0.1", resolve);
      });
      const context = await browser.newContext();
      // The panel's links to the app's server, held so the test can drop one as a laptop's sleep or a new network does.
      const links: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
      await context.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
        links.push({ page: ws, server: ws.connectToServer() });
      });
      try {
        const host = await context.newPage();
        await host.goto(`${HOST_APP}/doc`);
        const panel = host.frameLocator('iframe[title="omp"]');
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        const readies = () =>
          host.evaluate(() => (window as unknown as { ready: unknown[] }).ready.length);
        await expect.poll(readies).toBe(1);

        const before = links.length;
        for (const link of links) {
          await link.server.close();
          await link.page.close({ code: 4001, reason: "dropped" });
        }
        // The panel links again, and the chat takes the host's tool again, as the host hears.
        await expect.poll(() => links.length, { timeout: 60_000 }).toBeGreaterThan(before);
        await expect.poll(readies, { timeout: 30_000 }).toBe(2);

        await box.fill("call_tool page_title {}");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: host title: Host page title")).toBeVisible({
          timeout: 60_000,
        });
        expect(
          await host.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length),
        ).toBe(1);
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a panel loaded again on the chat it had gives that chat the host's tool once it is open, however slow its open",
    async ({ realApp, browser }) => {
      const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
      let chat: string | undefined;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(hostPage(app, realApp.token, false, chat));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(HOST_PORT, "127.0.0.1", resolve);
      });
      const context = await browser.newContext();
      try {
        const host = await context.newPage();
        await host.goto(`${HOST_APP}/doc`);
        const panel = host.frameLocator('iframe[title="omp"]');
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        // A chat with a reply in it: the one the panel comes back to.
        await box.fill("hello");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
        const lastReady = () =>
          host.evaluate(
            () =>
              (window as unknown as { ready: { chat: string; tools: string[] }[] }).ready.at(-1) ??
              null,
          );
        chat = (await lastReady())?.chat;
        expect(chat).toBeDefined();
        const shown = chat ?? "";

        // The panel loads again on that chat, and its open answers late: the chat's id is known before the server holds
        // the chat open for this page, and a tool given then was refused.
        await context.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
          const toServer = ws.connectToServer();
          ws.onMessage((message) => {
            if (
              typeof message === "string" &&
              message.includes('"method":"open"') &&
              message.includes(shown)
            )
              setTimeout(() => toServer.send(message), 1_500);
            else toServer.send(message);
          });
          toServer.onMessage((message) => ws.send(message));
        });
        await host.reload();
        await expect(panel.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(lastReady, { timeout: 30_000 })
          .toMatchObject({ chat: shown, tools: ["page_title"] });

        await box.fill("call_tool page_title {}");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: host title: Host page title")).toBeVisible({
          timeout: 60_000,
        });
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "in a frame that may open no window, as VS Code's, the arrow and Open in the desktop app ask the host to open them, and the panel stays",
    async ({ realApp, browser }) => {
      const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(hostPage(app, realApp.token, true));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(HOST_PORT, "127.0.0.1", resolve);
      });
      const context = await browser.newContext();
      try {
        const host = await context.newPage();
        await host.goto(`${HOST_APP}/doc`);
        const panel = host.frameLocator('iframe[title="omp"]');
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        await expect(panel.getByText("Hello from the host")).toBeVisible({ timeout: 30_000 });
        const opens = (): Promise<string[]> =>
          host.evaluate(() => (window as unknown as { opens: string[] }).opens);

        // The arrow: the host opens the full app, whole (on the chat the panel shows, when it has one); no window opens
        // from the frame.
        const escaped = app.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        await panel.getByRole("link", { name: "Open in the full app" }).click();
        await expect.poll(async () => (await opens()).length).toBe(1);
        expect((await opens())[0]).toMatch(new RegExp(`^${escaped}/(#chat=[0-9a-f-]+)?$`));
        expect(context.pages()).toHaveLength(1);

        // Open in the desktop app, from the arrow's menu: the host opens the desktop app's link, and the panel still
        // shows the chat (a frame that followed the link itself was left blank).
        await panel.getByRole("button", { name: "Where the full app opens" }).click();
        await panel.getByRole("menuitem", { name: "Open in the desktop app" }).click();
        await expect.poll(async () => (await opens()).length).toBe(2);
        expect((await opens())[1]).toMatch(
          new RegExp(`^omp-app://(open|chat/[0-9a-f-]+)\\?server=${encodeURIComponent(app)}$`),
        );
        await expect(box).toBeVisible();
        await expect(panel.getByRole("link", { name: "Open in the desktop app" })).toBeVisible();
        expect(context.pages()).toHaveLength(1);
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
