import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * VS Code's panel (`apps/vscode`): its page script (`webview.ts`), built from the source, in Chromium. The page stands in
 * for VS Code's webview and the extension (`panel.ts`): it gives the script `acquireVsCodeApi`, keeps the key and the
 * chat, and answers `vscode_read` from files it holds, as the extension answers from the open folder. The panel pairs
 * once; its chat is an ordinary chat in the app's folder on the server, with omp's own tools and the panel's tools by
 * name; the open file goes with each message.
 */
const ready = /^(Fake Model|Message omp)/;
const port = 41_000 + Math.floor(Math.random() * 20_000);
const WEBVIEW = `http://localhost:${port}`;

/** The panel's page script as the extension ships it: one script, built from the source. */
function webviewScript(): string {
  return execFileSync(
    "bun",
    [
      "build",
      resolve(APP_ROOT, "apps/vscode/src/webview.ts"),
      "--format",
      "iife",
      "--target",
      "browser",
    ],
    { encoding: "utf8" },
  );
}

/** The webview's page, as `panel.ts` writes it, and the stand-in for VS Code and the extension. */
const webviewPage = (app: string) => `<!doctype html><title>VS Code</title>
<style>html,body,#panel{height:760px;width:420px;margin:0}</style>
<div id="panel"></div><div id="note" role="status" hidden></div>
<script type="application/json" id="omp-app-config">${JSON.stringify({
  app,
  files: { project: "Demo App", id: "0123456789abcdef" },
  chat: null,
  context: { kind: "file", title: "src/app.ts", uri: "src/app.ts" },
})}</script>
<script>
window.files = { "README.md": "# Demo App, on the laptop" };
window.asked = [];
window.acquireVsCodeApi = () => ({
  postMessage(message) {
    window.asked.push(message.type === "ask" ? message.what : message.type);
    if (message.type !== "ask") return;
    let value = null;
    if (message.what === "key") value = localStorage.getItem("key");
    else if (message.what === "keep-key") localStorage.setItem("key", message.key);
    else if (message.what === "tool") value = window.files[message.args.path] ?? "no such file";
    setTimeout(() => window.postMessage({ ompAppExtension: 1, type: "answer", id: message.id, value }, "*"), 0);
  },
});
window.openFile = (context) => window.postMessage({ ompAppExtension: 1, type: "context", context }, "*");
</script>
<script src="/webview.js"></script>`;

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

realTest.describe("new UI lite view in VS Code's panel", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: WEBVIEW } });

  realTest(
    "pairs once with the key in VS Code's keeping; the chat works on the laptop's folder through the panel's tools, with the open file",
    async ({ realApp, browser }) => {
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

      const script = webviewScript();
      const server = createServer((request, response) => {
        if (request.url === "/webview.js") {
          response.writeHead(200, { "Content-Type": "text/javascript" });
          response.end(script);
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(webviewPage(app));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const context = await browser.newContext();
      try {
        const vscode = await context.newPage();
        await vscode.goto(`${WEBVIEW}/webview`);
        const panel = vscode.frameLocator('iframe[title="omp app"]');
        const pairing = panel.getByRole("heading", { name: "Pair this device" });
        await expect(pairing).toBeVisible({ timeout: 60_000 });
        await panel.getByRole("button", { name: "Enter a code instead" }).click();
        await panel.getByLabel("One-time code").fill(code);
        await panel.getByRole("button", { name: "Pair", exact: true }).click();

        // Paired: the extension keeps the key, and the panel shows the chat with the open file.
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        expect(
          await vscode.evaluate(() => localStorage.getItem("key")?.length ?? 0),
        ).toBeGreaterThan(20);
        const sentWith = panel.getByRole("region", {
          name: "Sent with your messages, from vscode",
        });
        await expect(sentWith).toContainText("src/app.ts");

        // omp offers the panel's tools by name, beside its own for the server's files and shell.
        await box.fill("tools_offered");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        const offered = panel.getByText(/^tools: /);
        await expect(offered).toBeVisible({ timeout: 60_000 });
        const names = ((await offered.textContent()) ?? "").replace(/^tools: /, "").split(", ");
        for (const name of ["vscode_read", "vscode_edit", "vscode_run", "vscode_search"])
          expect(names).toContain(name);
        for (const name of ["bash", "edit", "grep", "glob"]) expect(names).toContain(name);

        // A tool's call goes through the extension, and its answer reaches the chat.
        await box.fill('call_tool vscode_read {"path":"README.md"}');
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: # Demo App, on the laptop")).toBeVisible({
          timeout: 60_000,
        });
        expect(
          await vscode.evaluate(() => (window as unknown as { asked: string[] }).asked),
        ).toContain("tool");

        // Another open file, as the extension says when the person switches: the panel shows it.
        await vscode.evaluate(() =>
          (window as unknown as { openFile: (context: unknown) => void }).openFile({
            kind: "file",
            title: "src/other.ts",
            uri: "src/other.ts#L3-4",
            selection: "const x = 1;",
          }),
        );
        await expect(sentWith).toContainText("src/other.ts");

        // No folder of the project's own on the server: the panel's chat runs in the app's folder.
        await expect(stat(join(realApp.appDataDir, "host-folders"))).rejects.toThrow();

        // Next time VS Code opens the panel: signed in with the kept key, no pairing.
        await vscode.reload();
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        await expect(pairing).toHaveCount(0);
      } finally {
        await context.close();
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
