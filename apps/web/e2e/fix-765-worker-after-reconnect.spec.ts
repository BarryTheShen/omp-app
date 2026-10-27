import { join } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import { z } from "zod";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/**
 * A server frame on the chat's own event stream: a chat session event (A0's `ChatSessionEvent`). The other streams (the
 * config store and the rest) carry other payloads, so they do not match.
 */
const ChatEventFrame = z.object({
  type: z.literal("event"),
  payload: z.object({
    kind: z.enum(["event", "host_request", "shell", "process", "moved"]),
    event: z.object({ type: z.string(), payload: z.unknown() }).optional(),
  }),
});
type ChatEventFrame = z.infer<typeof ChatEventFrame>;

const LifecyclePayload = z.object({ status: z.string() });

/** The chat's event in a server frame, or undefined for any other frame. */
function chatEvent(message: string | Buffer): ChatEventFrame | undefined {
  let json: unknown;
  try {
    json = JSON.parse(String(message));
  } catch {
    return undefined;
  }
  const parsed = ChatEventFrame.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** omp's notice that a worker completed, on the chat's stream: the frame the Agent Hub must show as Finished. */
function isWorkerCompleted(frame: ChatEventFrame): boolean {
  const event = frame.payload.event;
  if (frame.payload.kind !== "event" || event?.type !== "subagent_lifecycle") return false;
  return LifecyclePayload.safeParse(event.payload).data?.status === "completed";
}

/** The page's socket: the live sockets a drop closes, and the reconnects refused while the outage lasts. */
interface Tab {
  outage: boolean;
  /** Set at the reconnect: the chat's events are withheld until the worker's end has been replayed. */
  withholding: boolean;
  /** How many chat events the reconnect's replay withheld from the page. */
  withheld: number;
  readonly live: WebSocketRoute[];
}

/**
 * Routes the page's WebSocket through the test: frames are forwarded both ways. While the reconnect's replay is arriving,
 * the chat's events before the worker's end are withheld, so the end reaches the page after a gap in the sequence.
 */
function routeSocket(target: Page, tab: Tab): Promise<void> {
  return target.routeWebSocket(/\/ws(\?|$)/, async (socket) => {
    if (tab.outage) {
      await socket.close();
      return;
    }
    const server = socket.connectToServer();
    tab.live.push(socket);
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const event = chatEvent(message);
      if (tab.withholding && event !== undefined) {
        if (isWorkerCompleted(event)) tab.withholding = false;
        else {
          tab.withheld += 1;
          return;
        }
      }
      socket.send(message);
    });
  });
}

/** The drop: the page's live sockets close, and every reconnect is refused until the outage ends. */
async function dropConnection(tab: Tab): Promise<void> {
  tab.outage = true;
  for (const socket of tab.live.splice(0)) await socket.close();
}

/**
 * Issue #765. A worker runs `sleep 60`. The page drops its connection while the worker runs, and the worker ends during the
 * outage. The reconnect replays what the page missed, but the worker's end arrives after a gap in the sequence (the replay
 * withholds the events before it). The Agent Hub must still read the worker as finished, as omp does.
 */
realTest(
  "a worker that ends while the page is disconnected reads as Finished in the Agent Hub after the reconnect",
  async ({ realApp }) => {
    // The browser reports each refused connection while the app is unreachable: expected here.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const tab: Tab = { outage: false, withholding: false, withheld: 0, live: [] };
    const page = await realApp.open({ beforeLoad: (target) => routeSocket(target, tab) });
    const composer = await startChat(page);
    const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
    if ((await showPanels.count()) > 0) await showPanels.first().click();
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });

    await sendPrompt(composer, "spawn_long_subagent");
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    // The worker's command sleeps 60 s from the moment it started, before this drop. Wait past its end.
    await dropConnection(tab);
    await page.waitForTimeout(75_000);

    tab.outage = false;
    tab.withholding = true;
    await expect(hub.getByRole("option", { name: /Finished.*LongProbe/ })).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(0);
    // The replay had events to withhold, so the worker's end did arrive after a gap.
    expect(tab.withheld).toBeGreaterThan(0);
    // The row as a person sees it: the Agent Hub in light, dark, and at 390 px, where the panels are a drawer.
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-765-hub-light.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-765-hub-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(hub).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-765-hub-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
