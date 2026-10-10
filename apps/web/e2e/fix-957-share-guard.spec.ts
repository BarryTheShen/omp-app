import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** What the app shows in place of every form of /share. It says that nothing was uploaded. */
const REFUSAL = "Sharing this chat isn't available yet. Nothing was uploaded.";

/** Forms that omp would run as its own /share: arguments, a colon, any letter case, leading spaces. */
const FORMS = ["/share now", "  /SHARE", "/share:now"];

interface ShareStub {
  readonly url: string;
  /** Every request the stub received, as "METHOD path". Empty means nothing was uploaded. */
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

/** A local stand-in for omp's share server. It records every request and answers an upload with an id. */
async function startShareStub(): Promise<ShareStub> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "0123456789abcdef" }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/s`,
    requests,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

/** omp reads `share.serverUrl` from `config.yml` in its agent folder, which the fixture keeps beside `mcp.json`. */
async function pointOmpAtStub(agentFolder: string, url: string): Promise<void> {
  await writeFile(join(agentFolder, "config.yml"), `share:\n  serverUrl: ${url}\n  store: blob\n`);
}

/** The shell's background is the `--background` token (bg-background on the shell root). */
async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(shell).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
      token,
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

realTest(
  "every form of /share is answered by the app, nothing is uploaded, and a plain prompt still reaches omp",
  async ({ realApp }) => {
    const stub = await startShareStub();
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open();
      const composer = await startChat(page);
      // A bare command opens the slash list, which holds Enter for its suggestion; Escape closes it, then Enter sends.
      await composer.fill("/share");
      await composer.press("Escape");
      await composer.press("Enter");
      await expect(page.getByText(REFUSAL)).toBeVisible();
      for (const form of FORMS) {
        await sendPrompt(composer, form);
        await expect(page.getByText(REFUSAL)).toBeVisible();
      }
      expect(stub.requests).toEqual([]);
      await expectTokenBackground(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-957-share-guard-light.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByText(REFUSAL)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-957-share-guard-narrow.png") });
      await sendPrompt(composer, "ping");
      await expect(page.getByText("pong")).toBeVisible();
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);

realTest(
  "the share refusal reads the same in dark mode, with nothing uploaded",
  async ({ realApp }) => {
    const stub = await startShareStub();
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open();
      await page.getByRole("radio", { name: "Dark" }).click();
      await waitForFiniteAnimations(page);
      const composer = await startChat(page);
      await sendPrompt(composer, "/share now");
      await expect(page.getByText(REFUSAL)).toBeVisible();
      await expectTokenBackground(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-957-share-guard-dark.png") });
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);
