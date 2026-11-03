import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Signing in to an MCP server again from Settings (#2779 D6.2), on real omp, against a fake remote server that signs in
 * through OAuth: without a token its endpoint answers 401 and points at its sign-in metadata. omp registers, the page to
 * open shows in Settings, the address the browser would end on is pasted there (omp waits for it on its own computer,
 * which another device's browser cannot reach), omp trades the code for a token, and the server connects again.
 */

interface FakeOAuthMcp {
  /** The MCP endpoint, as configured in omp. */
  readonly url: string;
  /** The tokens the fake gave out. */
  readonly tokens: string[];
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

/** An MCP server over HTTP behind OAuth: its metadata, registration, token, and the endpoint that wants the token. */
async function startFakeOAuthMcp(): Promise<FakeOAuthMcp> {
  const tokens: string[] = [];
  let origin = "";
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", origin);
    const body = await readBody(request);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.startsWith("/.well-known/openid-configuration")
    ) {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const registration = JSON.parse(body === "" ? "{}" : body) as { redirect_uris?: string[] };
      json(response, 201, {
        client_id: "fake-client",
        redirect_uris: registration.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "fake-code") {
        tokens.push("fake-token");
        json(response, 200, { access_token: "fake-token", token_type: "Bearer", expires_in: 3600 });
      } else {
        json(response, 400, { error: "invalid_grant" });
      }
      return;
    }
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== "Bearer fake-token") {
        response.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: number | string;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture-oauth", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Echo input.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {};
      json(response, 200, { jsonrpc: "2.0", id: message.id, result });
      return;
    }
    response.writeHead(404);
    response.end();
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    tokens,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const servers = (page: Page) => sheet(page).getByRole("region", { name: "MCP servers" });

realTest.describe("new UI: signing in to an MCP server again", () => {
  realTest.setTimeout(240_000);

  realTest(
    "Settings → Tools lists the server; Sign in again shows its page here and takes the pasted address, and it connects",
    async ({ realApp }) => {
      const fake = await startFakeOAuthMcp();
      try {
        writeFileSync(
          realApp.mcpConfigPath,
          JSON.stringify({ mcpServers: { "fixture-oauth": { type: "http", url: fake.url } } }),
        );
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          "Message omp",
          { timeout: 120_000 },
        );

        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await sheet(page)
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: /^Tools/ })
          .click();
        const row = servers(page).getByRole("listitem").filter({ hasText: "fixture-oauth" });
        await expect(row).toContainText("Enabled", { timeout: 60_000 });
        await row.getByRole("button", { name: "Sign in again" }).click();

        // The page to open is the server's own sign-in address, for any device's browser.
        const link = servers(page).getByRole("link", { name: "fixture-oauth's sign-in page" });
        await expect(link).toBeVisible({ timeout: 60_000 });
        const authorize = new URL((await link.getAttribute("href")) ?? "");
        expect(`${authorize.origin}${authorize.pathname}`).toBe(
          fake.url.replace(/\/mcp$/, "/authorize"),
        );

        // The address the browser ends on after signing in: omp's own callback, with the code and the state.
        const ended = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        ended.searchParams.set("code", "fake-code");
        ended.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        await servers(page)
          .getByRole("textbox", { name: "Paste its address here" })
          .fill(ended.toString());
        await servers(page).getByRole("button", { name: "Finish sign-in" }).click();

        await expect(
          servers(page).getByText("Signed in to fixture-oauth again; it is connected."),
        ).toBeVisible({ timeout: 60_000 });
        expect(fake.tokens).toEqual(["fake-token"]);
        expect(realApp.problems).toEqual([]);
      } finally {
        await fake.close();
      }
    },
  );
});
