import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

class HoldFirstNewChatOpen {
  private readonly requestIds = new Set<string>();
  private readonly waiting: Array<{
    readonly ws: WebSocketRoute;
    readonly message: string | Buffer;
  }> = [];
  private armed = false;
  private started = 0;
  private firstSessionFile: string | undefined;

  arm(): void {
    this.armed = true;
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  startedCount(): number {
    return this.started;
  }

  sessionFile(): string | undefined {
    return this.firstSessionFile;
  }

  release(): void {
    for (const reply of this.waiting.splice(0)) {
      const frame = frameOf(reply.message);
      const value = frame?.value as { sessionFile?: unknown } | undefined;
      if (typeof value?.sessionFile === "string") this.firstSessionFile = value.sessionFile;
      reply.ws.send(reply.message);
    }
  }

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = frameOf(message);
        if (
          this.armed &&
          frame?.type === "call" &&
          frame.port === "A0.rpcSession" &&
          frame.method === "open" &&
          (frame.args as { start?: unknown } | undefined)?.start === "new"
        ) {
          if (this.started === 0) this.requestIds.add(String(frame.id));
          this.started += 1;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = frameOf(message);
        if (frame?.type === "result" && this.requestIds.has(String(frame.id))) {
          this.waiting.push({ ws, message });
          return;
        }
        ws.send(message);
      });
    });
  }
}

async function userMessagesInFile(path: string, text: string): Promise<number> {
  let count = 0;
  for (const line of (await readFile(path, "utf8").catch(() => "")).split("\n")) {
    if (!line.includes(text)) continue;
    try {
      const compact = JSON.stringify(JSON.parse(line));
      if (compact.includes('"role":"user"') && compact.includes(text)) count += 1;
    } catch {
      // Ignore non-record lines.
    }
  }
  return count;
}

async function userMessagesHolding(agentDir: string, text: string): Promise<number> {
  const files = await readdir(`${agentDir}/sessions`, { recursive: true }).catch(() => []);
  let count = 0;
  for (const entry of files.map(String).filter((name) => name.endsWith(".jsonl"))) {
    count += await userMessagesInFile(`${agentDir}/sessions/${entry}`, text);
  }
  return count;
}
async function expectShellPainted(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#2343: a first send stays with its New chat when another New chat starts before it opens",
  async ({ realApp }) => {
    const hold = new HoldFirstNewChatOpen();
    const page = await realApp.open({ beforeLoad: (target) => hold.install(target) });
    const newChat = () =>
      page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
    const composer = await startChat(page);
    await sendPrompt(composer, "setup chat");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const message = `first-chat-${Date.now()}`;
    hold.arm();
    await newChat().click();
    await expect.poll(() => hold.waitingCount(), { timeout: 30_000 }).toBe(1);
    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), message);
    const secondClick = newChat().click();
    const startsBeforeFirstOpen = hold.startedCount();
    hold.release();
    await secondClick;

    await expect
      .poll(
        async () => {
          const sessionFile = hold.sessionFile();
          return sessionFile === undefined ? 0 : userMessagesInFile(sessionFile, message);
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    await expect.poll(() => userMessagesHolding(realApp.agentDir, message)).toBe(1);
    await expect.poll(() => hold.startedCount()).toBe(2);
    expect(startsBeforeFirstOpen).toBe(1);
    await expect(composer).toHaveValue("");
    await expect(page.locator('[data-empty-chat="true"]')).toBeVisible();
    await expectShellPainted(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2343-first-send-own-chat.png"),
      fullPage: true,
    });
    await expect(page.locator('[data-empty-chat="true"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="r1-session-row"]').filter({ hasText: message }),
    ).toHaveAttribute("data-selected", "false");
    await page.waitForTimeout(3000);
    await expect(page.locator('[data-empty-chat="true"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="r1-session-row"]').filter({ hasText: message }),
    ).toHaveAttribute("data-selected", "false");
    expect(realApp.problems).toEqual([]);
  },
);
