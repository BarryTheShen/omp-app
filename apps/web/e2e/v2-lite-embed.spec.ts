import { createServer, type Server } from "node:http";
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

/** The host page: frames the panel, answers its `listening` with a hello, and answers each call of its tool. */
function hostPage(app: string, token: string): string {
  const script = `
const frame = document.querySelector("iframe");
const app = ${JSON.stringify(app)};
window.calls = [];
window.ready = [];
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
});`;
  return `<!doctype html><title>host</title><iframe title="omp" style="width:420px;height:760px;border:0" src="${app}/lite#token=${encodeURIComponent(token)}"></iframe><script>${script}</script>`;
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
        await expect(sentWith).toContainText("Host page title (a selection)");
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
        ).toContainText("Host page title (a selection)");
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
        await expect(sentWith).toContainText("Another page");
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
