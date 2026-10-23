import type { Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 2537 (SU4): the file list's first answer is asked for once, a second after the chat's first paint and in idle
 * time, and never while the chat is opening. It is not asked for on the composer's first focus any more. This spec reads
 * the page's socket: no file search call leaves the page between the click on New chat and the chat's first paint, and
 * one for the empty query comes a second or more after it.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

/** A file search call the page sent: when it left the page (this process's clock) and its query. */
interface FileSearchCall {
  readonly at: number;
  readonly query: string;
}

/** The frames of a message that is a JSON object; a message that is not one has no fields. */
function frameOf(message: string | Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(String(message));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** The query in a file search call's arguments. */
function queryOf(args: unknown): string {
  return typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof args.query === "string"
    ? args.query
    : "";
}

/** Records every file search call the page sends, and passes every frame on unchanged. */
async function recordFileSearchCalls(page: Page, calls: FileSearchCall[]): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = frameOf(message);
      if (frame.type === "call" && frame.port === "A1.fileSearch") {
        calls.push({ at: Date.now(), query: queryOf(frame.args) });
      }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
}

realTest(
  "a chat's file list is first asked for a second after its first paint, and only once (issue 2537)",
  async ({ realApp }) => {
    const calls: FileSearchCall[] = [];
    const page = await realApp.open({
      beforeLoad: (target) => recordFileSearchCalls(target, calls),
    });
    const clickedAt = Date.now();
    await startChat(page);
    const paintedAt = Date.now();

    // Nothing is asked for between the click and the chat's first paint.
    expect(calls.filter((call) => call.at >= clickedAt && call.at < paintedAt)).toEqual([]);

    // Then one request for the empty query, a second after the paint; a second one would be a second warm-up.
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    expect(calls.map((call) => call.query)).toEqual([""]);
    expect((calls[0]?.at ?? paintedAt) - paintedAt).toBeGreaterThanOrEqual(900);
  },
);
