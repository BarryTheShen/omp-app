import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Ports and pages on your devices (#2788) on the real server and the fake model: a service on the machine is shared
 * with a click, Open signs this browser in through a one-time link and shows it, a request without that sign-in is
 * turned away, and Stop sharing ends it. A service a chat starts is shared by itself, and the chat says so with Open.
 * An HTML file in Files opens as a page, with its stylesheet. Both services send no type, as many small services do:
 * the share must show their pages, not download them. The shares listen on 127.0.0.1 here (`OMP_APP_SHARE_ADDRESS`), in
 * place of the machine's Tailscale address.
 */
realTest.use({ serverEnv: { OMP_APP_SHARE_ADDRESS: "127.0.0.1" } });

realTest.describe("new UI: ports and pages on your devices", () => {
  realTest.setTimeout(240_000);

  const ports = (page: Page) => page.getByRole("region", { name: "Ports" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  /** The tab a link opens; a link that opens none fails here, not at the test's own time limit. */
  const newTab = (page: Page) => page.context().waitForEvent("page", { timeout: 30_000 });

  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  }

  let service: Server | null = null;
  realTest.afterEach(async () => {
    const running = service;
    service = null;
    if (running === null) return;
    // The share's own connections to it close too: closing waits for every connection to end.
    running.closeAllConnections();
    await new Promise<void>((done) => running.close(() => done()));
  });

  realTest(
    "a service is shared with a click, opens through a one-time link, turns away a request without it, and stops",
    async ({ realApp }) => {
      const started = createServer((_request, response) => response.end("hello from the service"));
      service = started;
      await new Promise<void>((done) => started.listen(0, "127.0.0.1", done));
      const port = (started.address() as AddressInfo).port;

      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await page.getByRole("button", { name: "Ports", exact: true }).click();
      // A service no chat started is folded away under the machine's other services (#2836).
      const row = ports(page).getByRole("listitem", { name: `Port ${port}` });
      const others = ports(page).getByRole("button", { name: /^Other services on this machine/ });
      await expect(others).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
      await expect(row).toHaveCount(0);
      await others.click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole("button", { name: "Share", exact: true }).click();

      const open = row.getByRole("link", { name: "Open" });
      await expect(open).toBeVisible({ timeout: 15_000 });
      const enter = new URL((await open.getAttribute("href")) ?? "");
      expect(enter.pathname).toBe("/__omp-app/enter");
      const [shown] = await Promise.all([newTab(page), open.click()]);
      await expect(shown.locator("body")).toHaveText("hello from the service");
      await expect(row).toContainText("Opened on ");

      // Without the sign-in the link gave this browser, the share's address answers with a refusal.
      const stranger = await fetch(`${enter.origin}/`);
      expect(stranger.status).toBe(403);
      // The link counted once.
      const again = await fetch(enter.href, { redirect: "manual" });
      expect(again.status).toBe(403);

      await row.getByRole("button", { name: "Stop sharing" }).click();
      await expect(row.getByRole("button", { name: "Share", exact: true })).toBeVisible();
      await shown.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a service a chat starts is shared by itself, and the chat's line opens it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).fill("serve_probe");
      await box(page).press("Enter");

      const line = page.getByRole("status").filter({ hasText: /is listening on port \d+/ });
      await expect(line).toBeVisible({ timeout: 90_000 });
      const port = /port (\d+)/.exec((await line.textContent()) ?? "")?.[1] ?? "";
      const open = line.getByRole("link", { name: "Open" });
      await expect(open).toBeVisible({ timeout: 15_000 });
      const [shown] = await Promise.all([newTab(page), open.click()]);
      await expect(shown.locator("body")).toHaveText("served-by-chat");
      await shown.close();

      await page.getByRole("button", { name: "Ports", exact: true }).click();
      const row = ports(page).getByRole("listitem", { name: `Port ${port}` });
      await expect(row).toContainText("Started by a chat");
      await expect(row).toContainText("Shared by itself.");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "an HTML file in Files opens as a page of its own, with its stylesheet",
    async ({ realApp }) => {
      await mkdir(join(realApp.folder, "site"), { recursive: true });
      await writeFile(
        join(realApp.folder, "site/index.html"),
        '<!doctype html><link rel="stylesheet" href="style.css"><h1>A shared page</h1>',
      );
      await writeFile(join(realApp.folder, "site/style.css"), "h1 { color: rgb(255, 0, 0); }");

      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await page.getByRole("button", { name: "Files", exact: true }).click();
      const tree = page.getByRole("tree", { name: "Files" });
      await tree.getByRole("treeitem", { name: "site", exact: true }).click();
      await tree.getByRole("treeitem", { name: "index.html", exact: true }).click();

      const viewer = page.getByRole("region", { name: "File index.html" });
      await viewer.getByRole("button", { name: "Share as a page" }).click();
      const open = viewer.getByRole("link", { name: "Open in browser" });
      await expect(open).toBeVisible({ timeout: 15_000 });
      const [shown] = await Promise.all([newTab(page), open.click()]);
      await expect(shown.locator("h1")).toHaveText("A shared page");
      await expect(shown.locator("h1")).toHaveCSS("color", "rgb(255, 0, 0)");
      await shown.close();

      await page.getByRole("button", { name: "Ports", exact: true }).click();
      await expect(ports(page).getByRole("listitem", { name: "site/index.html" })).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "an HTML file the chat writes opens as a page from the write's card (#2836)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).fill(
        `call_tool write ${JSON.stringify({ path: "site/hello.html", content: "<h1>Written by the chat</h1>" })}`,
      );
      await box(page).press("Enter");
      // The write's card, opened: Share as a page, then Open in browser shows it.
      const card = page.locator(".tr-root .tv-head").filter({ hasText: "site/hello.html" }).first();
      await expect(card).toBeVisible({ timeout: 90_000 });
      await card.click();
      await page.getByRole("button", { name: "Share as a page" }).click();
      const open = page.getByRole("link", { name: "Open in browser" });
      await expect(open).toBeVisible({ timeout: 15_000 });
      const [shown] = await Promise.all([newTab(page), open.click()]);
      await expect(shown.locator("h1")).toHaveText("Written by the chat");
      await shown.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("a share at another address than its service", () => {
    // A share listens at the share's address and takes its service's port number there when it is free, as on the
    // machine's Tailscale address: here 127.0.0.2, while the chat's service listens at 127.0.0.1.
    realTest.use({ serverEnv: { OMP_APP_SHARE_ADDRESS: "127.0.0.2" } });

    realTest(
      "a chat's service keeps its one share while it runs, when the share took the same port number",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await box(page).fill("serve_probe");
        await box(page).press("Enter");
        const lines = page.getByRole("status").filter({ hasText: /is listening on port \d+/ });
        await expect(lines).toHaveCount(1, { timeout: 90_000 });
        const port = /port (\d+)/.exec((await lines.textContent()) ?? "")?.[1] ?? "";
        await page.getByRole("button", { name: "Ports", exact: true }).click();
        const row = ports(page).getByRole("listitem", { name: `Port ${port}` });
        await expect(row).toContainText("Shared by itself.");
        const at = new URL(
          (await row.getByRole("link", { name: "Open" }).getAttribute("href")) ?? "",
        );
        expect([at.hostname, at.port]).toEqual(["127.0.0.2", port]);
        // Five looks at the sockets later it is the same share: the chat has no second line, and it is still shared.
        await page.waitForTimeout(10_000);
        await expect(lines).toHaveCount(1);
        await expect(row).toContainText("Shared by itself.");
        expect(realApp.problems).toEqual([]);
      },
    );
  });
});
