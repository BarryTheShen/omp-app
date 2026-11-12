import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * The lite view in another app's panel (Integrations, part 1): which pages may frame it is a setting (Settings → App →
 * Integrations), counted from the panel's next load; and a panel in another site's frame, where the browser keeps no
 * cookie of the app, pairs once and is signed in after that with the key its host keeps.
 */
const ready = /^(Fake Model|Message omp)/;

/** Ends the host page's server and its open connections, so a repeat of the test can take its port again. */
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A host page on its own port, at `localhost`: another site than the app's `127.0.0.1`. */
async function hostServer(
  page: (app: string) => string,
  app: string,
): Promise<{ origin: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(page(app));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { origin: `http://localhost:${port}`, server };
}

/** Frames the lite view with the launch link, and notes whether the panel spoke (it does as soon as it loads). */
const linkedHost = (token: string) => (app: string) =>
  `<!doctype html><title>host</title>
<iframe title="omp" style="width:420px;height:760px;border:0" src="${app}/lite#token=${encodeURIComponent(token)}"></iframe>
<script>
window.listening = false;
const frame = document.querySelector("iframe");
window.addEventListener("message", (event) => {
  if (event.origin === ${JSON.stringify(app)} && event.source === frame.contentWindow && event.data?.type === "listening") window.listening = true;
});
</script>`;

/** `@omp-app/embed` as a host loads it: one module, built from the source. */
function embedLibrary(): string {
  return execFileSync(
    "bun",
    [
      "build",
      resolve(APP_ROOT, "packages/embed/src/index.ts"),
      "--format",
      "esm",
      "--target",
      "browser",
    ],
    { encoding: "utf8" },
  );
}

/**
 * The minimal host of `docs/integrations.md`, with the library: a panel whose host keeps its key (here in this page's
 * storage) and gives back the chat it showed, and one tool. It notes the keys it was handed and the calls it answered.
 */
const keepingHost = (app: string) => `<!doctype html><title>host</title>
<div id="panel" style="width:420px;height:760px"></div>
<script type="module">
import { openPanel } from "/omp-embed.js";
window.credentials = [];
window.calls = [];
const chat = localStorage.getItem("omp-chat");
openPanel({
  app: ${JSON.stringify(app)},
  into: document.getElementById("panel"),
  host: "testhost",
  title: "omp",
  ...(chat === null ? {} : { chat }),
  onReady: (ready) => localStorage.setItem("omp-chat", ready.chat),
  keys: {
    get: () => localStorage.getItem("omp-key"),
    set: (key) => {
      window.credentials.push(key);
      localStorage.setItem("omp-key", key);
    },
  },
  tools: [
    {
      name: "page_title",
      description: "Says the title of the page the host shows",
      parameters: { type: "object", properties: {} },
      run: () => {
        window.calls.push("page_title");
        return "host title: Host page title";
      },
    },
  ],
});
</script>`;

const listening = (host: Page): Promise<boolean> =>
  host.evaluate(() => (window as unknown as { listening: boolean }).listening);

async function frameRule(app: string): Promise<string> {
  const response = await fetch(`${app}/lite`);
  return response.headers.get("content-security-policy") ?? "";
}

async function openIntegrations(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByRole("region", { name: "Integrations" });
  await expect(section.getByRole("list", { name: "Kinds of panel" })).toBeVisible({
    timeout: 30_000,
  });
  return section;
}

async function hostPage(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext();
  const host = await context.newPage();
  await host.goto(`${origin}/doc`);
  return host;
}

realTest.describe("new UI lite view in another app's panel", () => {
  realTest.setTimeout(240_000);

  realTest(
    "who may frame it is a setting: a page not named cannot; named, it can from its next load; taken off, it cannot again; no page of the internet",
    async ({ realApp, browser }) => {
      const owner = await realApp.open({ path: "/" });
      const app = new URL(owner.url()).origin;
      const { origin, server } = await hostServer(linkedHost(realApp.token), app);
      try {
        // Not named: the lite view may not be framed, and the panel never speaks.
        expect(await frameRule(app)).not.toContain(origin);
        const host = await hostPage(browser, origin);
        await host.waitForTimeout(3_000);
        expect(await listening(host)).toBe(false);

        // Named in Settings: the next load shows the panel, with no restart.
        const section = await openIntegrations(owner);
        await section.getByLabel("Another page's address").fill(`${origin}/`);
        await section.getByRole("button", { name: "Add", exact: true }).click();
        await expect(section.getByRole("list", { name: "Pages that may show it" })).toContainText(
          origin,
        );
        expect(await frameRule(app)).toContain(`frame-ancestors ${origin}`);
        await host.reload();
        const panel = host.frameLocator('iframe[title="omp"]');
        await expect(panel.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          ready,
          { timeout: 120_000 },
        );
        expect(await listening(host)).toBe(true);

        // A page on another computer over plain HTTP is refused, and the list stays as it was.
        await section.getByLabel("Another page's address").fill("http://example.com");
        await section.getByRole("button", { name: "Add", exact: true }).click();
        await expect(section.getByRole("alert")).toContainText(
          '"http://example.com" is not one of these',
        );
        expect(await frameRule(app)).not.toContain("example.com");

        // A kind of panel: every Firefox and Zen extension.
        await section.getByRole("switch", { name: "Firefox and Zen extensions" }).click();
        await expect(
          section.getByRole("switch", { name: "Firefox and Zen extensions" }),
        ).toBeChecked();
        expect(await frameRule(app)).toContain("moz-extension:");

        // Taken off: the next load is refused again.
        await section.getByRole("button", { name: `Remove ${origin}` }).click();
        await expect(section.getByRole("button", { name: `Remove ${origin}` })).toHaveCount(0);
        expect(await frameRule(app)).not.toContain(origin);
        await host.reload();
        await host.waitForTimeout(3_000);
        expect(await listening(host)).toBe(false);
        await host.context().close();
      } finally {
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});

realTest.describe("new UI lite view in another site's panel, its key kept by its host", () => {
  realTest.setTimeout(240_000);
  const port = 41_000 + Math.floor(Math.random() * 20_000);
  realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: `http://localhost:${port}` } });

  realTest(
    "with the embed library: it pairs once and hands its host the key; each load after signs in with it; the host's tool answers; without the key, it pairs again",
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

      const library = embedLibrary();
      const server = createServer((request, response) => {
        if (request.url === "/omp-embed.js") {
          response.writeHead(200, { "Content-Type": "text/javascript" });
          response.end(library);
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(keepingHost(app));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      try {
        const host = await hostPage(browser, `http://localhost:${port}`);
        const panel = host.frameLocator('iframe[title="omp"]');
        const pairing = panel.getByRole("heading", { name: "Pair this device" });
        await expect(pairing).toBeVisible({ timeout: 60_000 });
        await panel.getByRole("button", { name: "Enter a code instead" }).click();
        await panel.getByLabel("One-time code").fill(code);
        await panel.getByRole("button", { name: "Pair", exact: true }).click();

        // Paired: the host got the key, and the panel loads signed in with it.
        const box = panel.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        const keys = await host.evaluate(
          () => (window as unknown as { credentials: string[] }).credentials,
        );
        expect(keys).toHaveLength(1);
        expect(keys[0]?.length).toBeGreaterThan(20);
        await expect(
          devices.getByRole("list", { name: "Paired devices" }).getByRole("listitem"),
        ).toHaveCount(1);

        // Each load after: signed in at once, no pairing.
        await host.reload();
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        await expect(pairing).toHaveCount(0);

        // The host's tool, given through the library: its answer reaches the chat.
        await box.fill("call_tool page_title {}");
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect(panel.getByText("tool said: host title: Host page title")).toBeVisible({
          timeout: 60_000,
        });
        expect(await host.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual(
          ["page_title"],
        );

        // The host gives back the chat it showed: the next load opens that chat again.
        await host.reload();
        await expect(panel.getByText("tool said: host title: Host page title")).toBeVisible({
          timeout: 60_000,
        });

        // The host's key is what signs it in: without it, the panel pairs again.
        await host.evaluate(() => localStorage.removeItem("omp-key"));
        await host.reload();
        await expect(pairing).toBeVisible({ timeout: 60_000 });
        await host.context().close();
      } finally {
        await stop(server);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
