import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, realTest } from "./real-omp";

/**
 * A panel whose project is open on the host's computer (VS Code on a laptop): its `hello` says so (`files`) and gives
 * the host's tools. The panel's chat is an ordinary chat in the app's folder on the server, with omp's own tools for
 * the server's files and shell; the host's tool, beside them, reaches the project on the host's computer.
 */
const HOST_PORT = 41_000 + Math.floor(Math.random() * 20_000);
const HOST_APP = `http://127.0.0.1:${HOST_PORT}`;
const ready = /^(Fake Model|Message omp)/;

function hostPage(app: string, token: string): string {
  const script = `
const frame = document.querySelector("iframe");
const app = ${JSON.stringify(app)};
const send = (message) => frame.contentWindow.postMessage({ omp: "embed", v: 1, ...message }, app);
window.addEventListener("message", (event) => {
  if (event.origin !== app || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (message === null || typeof message !== "object" || message.omp !== "embed") return;
  if (message.type === "listening") {
    send({
      type: "hello",
      host: "testhost",
      files: { project: "Demo App", id: "0123456789abcdef" },
      tools: [{
        name: "testhost_read",
        description: "Reads a file of the project on the host's computer",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    });
  }
  if (message.type === "tool_call") {
    send({ type: "tool_result", callId: message.callId, result: { content: [{ type: "text", text: "# Demo App, on the host" }] } });
  }
});`;
  return `<!doctype html><title>host</title><iframe title="omp" style="width:420px;height:760px;border:0" src="${app}/lite#token=${encodeURIComponent(token)}"></iframe><script>${script}</script>`;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

realTest.describe("new UI lite view for a project open on the host's computer", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: HOST_APP } });

  realTest(
    "the chat runs in the app's folder with omp's own tools, and the host's tool beside them reads the host's files",
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

        // The tools omp offers the chat: its own, for the server's files and shell, and the host's beside them.
        await box.fill("tools_offered");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        const offered = panel.getByText(/^tools: /);
        await expect(offered).toBeVisible({ timeout: 60_000 });
        const names = ((await offered.textContent()) ?? "").replace(/^tools: /, "").split(", ");
        for (const name of ["testhost_read", "read", "write", "bash", "edit", "grep"])
          expect(names).toContain(name);

        // The host's tool reaches the project's files on the host's computer.
        await box.fill('call_tool testhost_read {"path":"README.md"}');
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: # Demo App, on the host")).toBeVisible({
          timeout: 60_000,
        });

        // omp's own shell runs in the app's folder on the server, as any chat's does.
        await box.fill(`call_tool bash ${JSON.stringify({ command: "pwd" })}`);
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText(`tool said: ${realApp.folder}`, { exact: false })).toBeVisible(
          {
            timeout: 60_000,
          },
        );

        // No folder of the project's own is made on the server.
        await expect(stat(join(realApp.appDataDir, "host-folders"))).rejects.toThrow();
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
