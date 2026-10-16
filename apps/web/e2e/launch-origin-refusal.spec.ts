/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createServer, request } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function startOriginRewritingProxy(target: URL): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const proxy = createServer((incoming, response) => {
    const upstream = fetchRequest(target, incoming);
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end());
    incoming.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  proxy.on("upgrade", (incoming, socket, head) => {
    const upstream = connect(Number(target.port), target.hostname);
    upstream.once("connect", () => {
      const headers = Object.entries(incoming.headers)
        .filter(([name]) => name !== "host")
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\nHost: ${target.host}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    throw new Error("The origin-refusal proxy did not receive a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      }),
  };
}

function fetchRequest(target: URL, incoming: IncomingMessage): ClientRequest {
  return request({
    hostname: target.hostname,
    port: Number(target.port),
    method: incoming.method,
    path: incoming.url,
    headers: { ...incoming.headers, host: target.host },
  });
}

async function showRefusal(page: Page, url: string, theme: "light" | "dark"): Promise<void> {
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "This page address is not allowed to reach omp-app" }),
  ).toBeVisible();
  await expect(
    page.getByText("Open the URL the app printed when it last started, from the same machine."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "This launch link has expired" })).toHaveCount(0);
  const main = page.locator("main");
  await expect(main).toHaveAttribute("data-launch-state", "origin-rejected");
  const expectedBackground = theme === "dark" ? "oklch(20.96% .0166 268.85)" : "oklch(97.91% 0 0)";
  await expect
    .poll(() =>
      main.evaluate((element) => getComputedStyle(element).getPropertyValue("--background").trim()),
    )
    .toBe(expectedBackground);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
}

realTest("a page from a disallowed origin explains how to reach the app", async ({ realApp }) => {
  const lightPage = await realApp.open({
    expectApp: false,
    beforeLoad: (page) => page.emulateMedia({ colorScheme: "light" }),
  });
  const target = new URL(lightPage.url());
  const proxy = await startOriginRewritingProxy(target);
  const launchLink = `${proxy.url}/#token=${encodeURIComponent(realApp.token)}`;
  let darkPage: Page | undefined;
  try {
    await showRefusal(lightPage, launchLink, "light");
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(lightPage);
    await lightPage.screenshot({
      path: join(screenshots, "launch-origin-refusal-light.png"),
      fullPage: true,
    });

    const renderedDarkPage = await realApp.open({
      expectApp: false,
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    darkPage = renderedDarkPage;
    await showRefusal(renderedDarkPage, launchLink, "dark");
    await waitForFiniteAnimations(renderedDarkPage);
    await renderedDarkPage.screenshot({
      path: join(screenshots, "launch-origin-refusal-dark.png"),
      fullPage: true,
    });

    await renderedDarkPage.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => renderedDarkPage.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(renderedDarkPage);
    await renderedDarkPage.screenshot({
      path: join(screenshots, "launch-origin-refusal-narrow.png"),
      fullPage: true,
    });
  } finally {
    await lightPage.close();
    if (darkPage !== undefined) await darkPage.close();
    await proxy.close();
  }
});
