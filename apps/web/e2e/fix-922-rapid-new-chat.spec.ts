import type { Locator, Page, WebSocket } from "@playwright/test";
import { expect, realTest } from "./real-omp";

realTest.setTimeout(300_000);

function newChatButton(page: Page): Locator {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** Counts the calls the app sends to the session port (open, close and the rest), from page load on. */
function countSessionCalls(page: Page, counts: Map<string, number>): void {
  page.on("websocket", (socket: WebSocket) => {
    socket.on("framesent", (event) => {
      if (typeof event.payload !== "string") return;
      const frame = JSON.parse(event.payload) as { type?: string; method?: string; port?: string };
      if (frame.type !== "call" || frame.port !== "A0.chatSession") return;
      counts.set(frame.method ?? "?", (counts.get(frame.method ?? "?") ?? 0) + 1);
    });
  });
}

/** The chat the clicks opened is usable: it is not still loading, text typed in it stays, and a prompt gets its reply. */
async function expectUsableNewChat(page: Page): Promise<void> {
  await expect(page.getByText(/Loading conversation/)).toHaveCount(0, { timeout: 60_000 });
  await expect(composer(page)).toBeVisible({ timeout: 60_000 });
  await composer(page).fill("typing after the burst");
  await expect(composer(page)).toHaveValue("typing after the burst");
  await composer(page).fill("ping");
  await composer(page).press("Enter");
  await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
}

realTest(
  "ten fast clicks on New chat, then five more, open one chat that takes text and a prompt",
  async ({ realApp }) => {
    const calls = new Map<string, number>();
    const page = await realApp.open({
      beforeLoad: async (loading) => countSessionCalls(loading, calls),
    });
    await newChatButton(page).evaluate((element) => {
      for (let index = 0; index < 10; index += 1) (element as HTMLButtonElement).click();
    });
    for (let index = 0; index < 5; index += 1) await newChatButton(page).click();
    await page.waitForTimeout(8_000);
    // One New chat is two session calls: the open that creates it and the release of the adapter's hold on it.
    // Each click used to open and close the chat again, so the burst sent fifteen opens.
    expect(calls.get("open") ?? 0).toBeLessThanOrEqual(2);
    await expectUsableNewChat(page);
  },
);

realTest(
  "a double click on New chat opens one chat that takes text and a prompt",
  async ({ realApp }) => {
    const calls = new Map<string, number>();
    const page = await realApp.open({
      beforeLoad: async (loading) => countSessionCalls(loading, calls),
    });
    await newChatButton(page).dblclick();
    await page.waitForTimeout(8_000);
    expect(calls.get("open") ?? 0).toBeLessThanOrEqual(2);
    await expectUsableNewChat(page);
  },
);
