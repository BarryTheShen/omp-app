import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

async function failFirstServerInfo(page: Page): Promise<{ readonly held: Promise<() => void> }> {
  let releaseHeld!: (release: () => void) => void;
  const held = new Promise<() => void>((resolve) => {
    releaseHeld = resolve;
  });
  let failed = false;
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(message));
    socket.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("utf8");
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        server.send(message);
        return;
      }
      if (
        !failed &&
        frame.type === "call" &&
        frame.port === "A0.app" &&
        frame.method === "serverInfo" &&
        typeof frame.id === "string"
      ) {
        failed = true;
        releaseHeld(() =>
          socket.send(
            JSON.stringify({
              type: "result",
              id: frame.id,
              ok: false,
              error: {
                code: "internal",
                message: "The server-info request failed once.",
                retryable: true,
              },
            }),
          ),
        );
        return;
      }
      server.send(message);
    });
  });
  return { held };
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.locator("main").evaluate((main) => ({
    background: getComputedStyle(main).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
  }));
  expect(styles.token).not.toBe("");
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "first answers show pending and failure screens, then Retry loads the app without a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const modes = [
      { name: "light", dark: false, width: 1280 },
      { name: "dark", dark: true, width: 1280 },
      { name: "390", dark: false, width: 390 },
    ] as const;

    for (const [index, mode] of modes.entries()) {
      let releaseFailure: (() => void) | undefined;
      const page = await realApp.open({
        expectApp: false,
        beforeLoad: async (target) => {
          if (mode.dark) await target.emulateMedia({ colorScheme: "dark" });
          if (mode.width !== 1280) await target.setViewportSize({ width: mode.width, height: 844 });
          const { held } = await failFirstServerInfo(target);
          void held.then((release) => {
            releaseFailure = release;
          });
        },
      });
      await expect(page.getByRole("heading", { name: "Connecting to omp-app" })).toBeVisible();
      await expect(page.getByText("Waiting for the app server to answer.")).toBeVisible();
      await expectStylesLoaded(page);
      await page.screenshot({
        path: `${screenshots}/fix-1301-first-answers-${mode.name}-pending.png`,
      });

      await expect.poll(() => releaseFailure !== undefined).toBe(true);
      releaseFailure?.();
      await expect(
        page.getByRole("heading", { name: "Could not connect to omp-app" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expectStylesLoaded(page);
      await page.screenshot({
        path: `${screenshots}/fix-1301-first-answers-${mode.name}-failed.png`,
      });

      if (index === 0) {
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 60_000 });
        expect(realApp.problems).toEqual([]);
      }
      if (index !== 0) await page.close();
    }
  },
);
