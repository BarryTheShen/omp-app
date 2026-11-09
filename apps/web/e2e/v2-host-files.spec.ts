import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, realTest } from "./real-omp";

/**
 * A panel whose project's files are on the host's computer (VS Code on a laptop): its `hello` says so (`files`). The
 * panel's chat runs in the server's folder for that project, made empty in the app's data; omp offers it none of its
 * own tools for the server's files and shell, and the host's tool reaches the files.
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

realTest.describe("new UI lite view for a project whose files are on the host's computer", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: HOST_APP } });

  realTest(
    "the chat runs in the project's own folder on the server, without omp's file and shell tools; the host's tool reads the files",
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

        // The tools omp offers the chat: the host's, read and write, and none for the server's files or shell.
        await box.fill("tools_offered");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        const offered = panel.getByText(/^tools: /);
        await expect(offered).toBeVisible({ timeout: 60_000 });
        const names = ((await offered.textContent()) ?? "").replace(/^tools: /, "").split(", ");
        for (const name of ["testhost_read", "read", "write"]) expect(names).toContain(name);
        for (const name of ["bash", "edit", "grep", "glob", "eval", "task"])
          expect(names).not.toContain(name);

        // The host's tool reaches the project's files.
        await box.fill('call_tool testhost_read {"path":"README.md"}');
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: # Demo App, on the host")).toBeVisible({
          timeout: 60_000,
        });

        // The project's folder on the server: made in the app's data, private.
        const folder = join(
          realApp.appDataDir,
          "host-folders",
          "testhost",
          "demo-app-0123456789ab",
        );
        expect(((await stat(folder)).mode & 0o777).toString(8)).toBe("700");
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
