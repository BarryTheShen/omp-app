import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { whyNotShown } from "./check";

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

describe("whyNotShown", () => {
  test("nothing to say when the app lets VS Code's panel frame it, or sets no frame rule", async () => {
    const allowed = await app(200, {
      "content-security-policy":
        "frame-ancestors https://notes.example.com vscode-webview: vscode-file:",
    });
    expect(await whyNotShown(allowed)).toBeNull();
    expect(await whyNotShown(await app(200))).toBeNull();
  });

  test("an app that does not let VS Code frame it: what to turn on in the app", async () => {
    for (const policy of [
      "frame-ancestors https://notes.example.com",
      "frame-ancestors 'none'",
      "default-src 'self'; frame-ancestors vscode-webview:",
    ]) {
      const address = await app(200, { "content-security-policy": policy });
      expect(await whyNotShown(address)).toEqual({
        kind: "not-allowed",
        text: `omp app at ${address} doesn't let VS Code show it yet. In omp app, turn on Settings → App → Integrations → VS Code, then click Try again.`,
      });
    }
  });

  test("an address that answers with something other than the app's page, or a redirect, says so", async () => {
    const missing = await app(404);
    const notFound = await whyNotShown(missing);
    expect(notFound?.kind).toBe("not-the-app");
    expect(notFound?.text).toMatch(new RegExp(`^${missing} answered 404`));
    const moved = await app(302, { location: "https://login.example.com/" });
    const redirected = await whyNotShown(moved);
    expect(redirected?.kind).toBe("not-the-app");
    expect(redirected?.text).toMatch(new RegExp(`^${moved} answered 302`));
  });

  test("nothing listening at the address: it can't be reached", async () => {
    const gone = await app(200);
    await Promise.all(
      servers.splice(0).map((server) => new Promise((done) => server.close(() => done(null)))),
    );
    const unreachable = await whyNotShown(gone);
    expect(unreachable?.kind).toBe("unreachable");
    expect(unreachable?.text).toMatch(new RegExp(`^omp app can't be reached at ${gone} \\(`));
  });
});
