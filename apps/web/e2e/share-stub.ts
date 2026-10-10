import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { APP_ROOT, expect } from "./real-omp";

/** The question the share confirmation opens with. */
export const SHARE_QUESTION = "Share this chat as a link?";
/** The id the stub gives every upload. */
export const SHARE_LINK_ID = "0123456789abcdef";

const TLS_DIR = resolve(APP_ROOT, ".data/share-stub-tls");
const TLS_KEY_FILE = join(TLS_DIR, "key.pem");
/** The test certificate's path. omp trusts it through NODE_EXTRA_CA_CERTS. */
export const TLS_CERT_FILE = join(TLS_DIR, "cert.pem");

/** Makes a test-only certificate for 127.0.0.1 under the git-ignored `.data` folder. Needs `openssl` on PATH. */
export function makeTestCertificate(): void {
  mkdirSync(TLS_DIR, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      TLS_KEY_FILE,
      "-out",
      TLS_CERT_FILE,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}

export interface ShareStub {
  /** The `share.serverUrl` omp uploads to. */
  readonly url: string;
  /** Every request the stub received, as "METHOD path". Empty means nothing was uploaded. */
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

/**
 * A local stand-in for omp's share server. It records every request and answers an upload with a link id.
 * With `tls`, it serves HTTPS, which the link omp shows needs. Without it, an upload attempt still reaches
 * `requests`, so a test that expects no upload can see one.
 */
export async function startShareStub({ tls }: { tls: boolean }): Promise<ShareStub> {
  const requests: string[] = [];
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: SHARE_LINK_ID }));
    });
  };
  const server: Server = tls
    ? createHttpsServer(
        { key: readFileSync(TLS_KEY_FILE), cert: readFileSync(TLS_CERT_FILE) },
        answer,
      )
    : createHttpServer(answer);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The share stub is not on a TCP port.");
  return {
    url: `${tls ? "https" : "http"}://127.0.0.1:${address.port}/s`,
    requests,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

/** omp reads `share.serverUrl` from `config.yml` in its agent folder, which the fixture keeps beside `mcp.json`. */
export async function pointOmpAtStub(agentFolder: string, url: string): Promise<void> {
  await writeFile(join(agentFolder, "config.yml"), `share:\n  serverUrl: ${url}\n  store: blob\n`);
}

/** The question, and the sentence that says where the chat is uploaded before anything is sent. */
export async function expectShareQuestion(page: Page, url: string): Promise<void> {
  await expect(page.getByRole("heading", { name: SHARE_QUESTION })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`It is encrypted and uploaded to ${url}.`)).toBeVisible();
}

/**
 * Types a message and sends it with the composer's send button, not Enter. With the slash list open, Enter takes the
 * list's suggestion: after a share was denied, `/share now` was typed and Enter turned it into `/share ` without sending.
 */
export async function sendTyped(page: Page, composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
