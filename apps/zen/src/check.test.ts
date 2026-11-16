import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { framesSidebar, noAnswerText, whyNotShown } from "./check";

const EXTENSION = "moz-extension://6f0d3c2e-8a51-4b7e-9c44-2d1e5f7a9b03";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => server.close(() => done(null)))),
  );
});

/** An app at a loopback address whose `/lite` answers with `status` and these headers. */
async function app(status: number, headers: Record<string, string> = {}): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/lite"))
      response.writeHead(status, headers).end("<!doctype html>");
    else response.writeHead(404).end("not here");
  });
  servers.push(server);
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(null)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A loopback address nothing listens on: a port a server had a moment ago. */
async function nothingThere(): Promise<string> {
  const server = createServer();
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(null)));
  const port = (server.address() as AddressInfo).port;
  await new Promise((closed) => server.close(() => closed(null)));
  return `http://127.0.0.1:${port}`;
}

describe("why omp app's page did not open in the sidebar", () => {
  test("nothing to say when the app lets the sidebar frame it, as omp app does, or sets no frame rule", async () => {
    // The lite view's rule as omp app sends it (`liteFrameAncestors`).
    const allowed = await app(200, {
      "content-security-policy":
        "frame-ancestors moz-extension: chrome-extension: vscode-webview: vscode-file:",
    });
    expect(await whyNotShown(allowed, EXTENSION)).toBeNull();
    expect(await whyNotShown(await app(200), EXTENSION)).toBeNull();
  });

  test("an app nothing answers at is named, with the browser's reason", async () => {
    const address = await nothingThere();
    const why = await whyNotShown(address, EXTENSION);
    expect(why?.kind).toBe("unreachable");
    expect(why?.text).toMatch(
      new RegExp(
        `^omp app can't be reached at ${address} \\(.+\\)\\. Check that omp app is running`,
      ),
    );
  });

  test("an address that answers with an error is not omp app's page", async () => {
    const why = await whyNotShown(await app(404), EXTENSION);
    expect(why?.kind).toBe("not-the-app");
    expect(why?.text).toContain("answered 404");
  });

  test("an app whose frame rule leaves the sidebar out is older than the extension", async () => {
    for (const policy of [
      "frame-ancestors 'none'",
      "default-src 'self'; frame-ancestors vscode-webview:",
    ]) {
      const why = await whyNotShown(
        await app(200, { "content-security-policy": policy }),
        EXTENSION,
      );
      expect(why?.kind).toBe("not-allowed");
      expect(why?.text).toContain("Update omp app");
    }
  });

  test("the frame rule may name this extension alone, or any page", () => {
    expect(framesSidebar(`frame-ancestors ${EXTENSION}`, EXTENSION)).toBe(true);
    expect(
      framesSidebar(
        "frame-ancestors moz-extension://00000000-0000-4000-8000-000000000000",
        EXTENSION,
      ),
    ).toBe(false);
    expect(framesSidebar("frame-ancestors *", EXTENSION)).toBe(true);
    expect(framesSidebar("default-src 'self'", EXTENSION)).toBe(true);
  });

  test("an app that answers as it should leaves the sidebar a next step, not a reason", () => {
    expect(noAnswerText("https://omp.example.com", null)).toBe(
      "omp app at https://omp.example.com answers, but its page didn't open in this sidebar. Click Try again; if it stays like this, open https://omp.example.com in a tab to see whether it opens there.",
    );
  });
});
