import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

function asksForEntries(message: string | Buffer): boolean {
  const text = typeof message === "string" ? message : message.toString("utf8");
  // The session port's `request`, with omp's method `get_entries` in its arguments.
  return text.includes('"method":"request"') && text.includes('"method":"get_entries"');
}
function errorBanner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}
function frameId(message: string | Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      typeof message === "string" ? message : message.toString("utf8"),
    );
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "id" in parsed &&
      typeof parsed.id === "string"
    ) {
      return parsed.id;
    }
  } catch {
    // Non-JSON frames are forwarded unchanged.
  }
  return undefined;
}
function waitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

realTest(
  "reloads an existing chat history after omp stops during its initial history load",
  async ({ realApp }) => {
    let holdNextEntries = false;
    let releaseHeldEntries: (() => void) | undefined;
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/\/ws\?/, (socket: WebSocketRoute) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            if (holdNextEntries && asksForEntries(message)) {
              holdNextEntries = false;
              releaseHeldEntries = () => server.send(message);
              return;
            }
            server.send(message);
          });
          server.onMessage((message) => socket.send(message));
        });
      },
    });
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const firstComposer = await startChat(page);
    await sendPrompt(firstComposer, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    holdNextEntries = true;
    await page.reload();
    await expect.poll(() => releaseHeldEntries !== undefined, { timeout: 60_000 }).toBe(true);
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(0);

    const killed = realApp.ompProcesses();
    expect(killed).toHaveLength(1);
    const pid = killed[0];
    if (pid === undefined) throw new Error("no omp process is running");
    process.kill(pid, "SIGSTOP");
    releaseHeldEntries?.();
    // Give the WebSocket forwarding turn time to reach the server while omp is stopped.
    await waitMs(1_000);
    process.kill(pid, "SIGKILL");
    const banner = errorBanner(page);
    await expect(banner).toContainText("omp exited (signal SIGKILL)", { timeout: 30_000 });
    await expect(banner.getByRole("button", { name: "Restart omp" })).toBeVisible();
    await banner.getByRole("button", { name: "Restart omp" }).click();
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("No messages yet.")).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
realTest(
  "recovers a chat picked from the sidebar when omp stops during its history load, with no reload and no restart",
  async ({ realApp }) => {
    let holdNextEntries = false;
    let releaseHeldEntries: (() => void) | undefined;
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/\/ws\?/, (socket: WebSocketRoute) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            if (holdNextEntries && asksForEntries(message)) {
              holdNextEntries = false;
              releaseHeldEntries = () => server.send(message);
              return;
            }
            server.send(message);
          });
          server.onMessage((message) => socket.send(message));
        });
      },
    });
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const firstComposer = await startChat(page);
    await sendPrompt(firstComposer, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const firstProcess = realApp.ompProcesses()[0];
    if (firstProcess === undefined) throw new Error("the first chat's omp process is not running");

    const secondComposer = await startChat(page);
    await sendPrompt(secondComposer, "ping second");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const sessionList = page.getByRole("listbox", { name: "Session list" });
    await expect(sessionList.getByRole("option")).toHaveCount(2, { timeout: 60_000 });
    const firstChatRow = sessionList.getByRole("option").nth(1);
    const firstChatTitle = (await firstChatRow.innerText()).split("\n")[0]?.trim() ?? "";
    if (firstChatTitle === "") throw new Error("the first chat's sidebar row has no title");
    await expect(firstChatRow).toContainText(firstChatTitle);
    await expect.poll(() => realApp.ompProcesses().length, { timeout: 30_000 }).toBe(2);
    expect(realApp.ompProcesses()).toContain(firstProcess);

    holdNextEntries = true;
    // Session rows are newest first, so the second row is the first chat. Its process was captured before New chat
    // opened the second process; that comparison keeps the process stopped below from belonging to the chat on screen.
    await firstChatRow.click();
    await expect(
      page.locator(
        '[role="listbox"][aria-label="Session list"] [data-slot="r1-session-row"][data-selected="true"]',
      ),
    ).toContainText(firstChatTitle);
    await expect.poll(() => releaseHeldEntries !== undefined, { timeout: 60_000 }).toBe(true);
    expect(realApp.ompProcesses()).toContain(firstProcess);
    // Kind: waits for the picked chat's history read, which this test holds, and then kills its omp. Since issue 2212 the
    // picked chat shows at the click, so while the read is held its opening state shows and the chat left is not on screen.
    await expect(page.getByText("Opening session…").first()).toBeVisible();
    await expect(transcript.getByText("ping second", { exact: true })).toHaveCount(0);

    process.kill(firstProcess, "SIGSTOP");
    releaseHeldEntries?.();
    // Give the WebSocket forwarding turn time to reach the server while the picked chat's omp is stopped.
    await waitMs(1_000);
    process.kill(firstProcess, "SIGKILL");

    const banner = errorBanner(page);
    const bannerWasVisible = await banner
      .first()
      .isVisible()
      .catch(() => false);
    if (bannerWasVisible) {
      await page.emulateMedia({ colorScheme: "light" });
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1731-history-switch-exit-banner-light.png"),
        fullPage: true,
      });
    }
    const selectedRow = page.locator(
      '[role="listbox"][aria-label="Session list"] [data-slot="r1-session-row"][data-selected="true"]',
    );
    await expect(selectedRow).toContainText(firstChatTitle, { timeout: 30_000 });
    const pickedUserBubble = transcript
      .locator('[data-message-surface="user-bubble"]')
      .filter({ hasText: /^\s*ping\s*$/ });
    const pickedAssistantRow = pickedUserBubble.locator(
      'xpath=following::div[@data-role="assistant"][1]',
    );
    await expect(pickedAssistantRow.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("No messages yet.")).toHaveCount(0);

    await page.emulateMedia({ colorScheme: "light" });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1731-history-switch-recovered-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1731-history-switch-recovered-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1731-history-switch-recovered-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("shows and retries a history load failure in an open chat", async ({ realApp }) => {
  let failEntries = false;
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.routeWebSocket(/\/ws\?/, (socket: WebSocketRoute) => {
        // Request ids start again on every page load, so each socket keeps its own failed ids: an id left over from the
        // page that reload closed must not turn a later request with the same id into a failure.
        const failedEntries = new Set<string>();
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          if (failEntries && asksForEntries(message)) {
            const id = frameId(message);
            if (id !== undefined) failedEntries.add(id);
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const id = frameId(message);
          if (id !== undefined && failedEntries.delete(id)) {
            socket.send(
              JSON.stringify({
                type: "result",
                id,
                ok: false,
                error: {
                  code: "omp_exited",
                  message: "omp exited while reading the chat history",
                  retryable: true,
                },
              }),
            );
            return;
          }
          socket.send(message);
        });
      });
    },
  });
  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
    timeout: 120_000,
  });
  await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

  failEntries = true;
  await page.reload();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "Earlier messages could not be loaded." });
  await expect(transcript).toBeVisible();
  await expect(notice).toContainText("omp exited while reading the chat history", {
    timeout: 60_000,
  });
  await expect(transcript.getByText("pong", { exact: true })).toHaveCount(0);
  expect(await notice.evaluate((element) => getComputedStyle(element).borderColor)).not.toBe("");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1731-history-retry-light.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1731-history-retry-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1731-history-retry-390.png"),
    fullPage: true,
  });

  failEntries = false;
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
    timeout: 120_000,
  });
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
  expect(realApp.problems).toEqual([]);
});
