import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

realTest.use({ seedSessions: 60 });

/**
 * The sessions list (issue 664): clicking a chat used to fetch the whole list again and swap it for
 * grey placeholder rows each time. Now the list that has loaded stays: opening a chat fetches
 * nothing, a refresh after a turn runs in the background with the rows still on screen, and a
 * failed refresh keeps them and says so in one line.
 *
 * The page's WebSocket is routed through the test so it can count the list requests and hold one result or
 * fail every refresh in a turn.
 */
interface ListWire {
  /** How many `listSessions` calls the page has made. */
  readonly calls: () => number;
  /** Hold the next list result for 3 s. */
  readonly delayNext: () => void;
  /** Fail each list call until the test ends. */
  readonly failRefreshes: () => void;
}

async function routeListSessions(page: Page): Promise<ListWire> {
  let calls = 0;
  let delay = false;
  let failing = false;
  const held = new Map<string, "delay" | "fail">();
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes('"method":"listSessions"')) {
        const frame = JSON.parse(message) as { id: string };
        calls += 1;
        // A delayed result is one-shot; failures persist through start and end refreshes.
        if (failing) {
          held.set(frame.id, "fail");
        } else if (delay) {
          held.set(frame.id, "delay");
          delay = false;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === "string" && message.startsWith('{"type":"result"')) {
        const frame = JSON.parse(message) as { id: string };
        const mode = held.get(frame.id);
        if (mode !== undefined) {
          held.delete(frame.id);
          if (mode === "fail") {
            ws.send(
              JSON.stringify({
                type: "result",
                id: frame.id,
                ok: false,
                error: { code: "internal", message: "The disk is busy.", retryable: true },
              }),
            );
          } else {
            setTimeout(() => ws.send(message), 3_000);
          }
          return;
        }
      }
      ws.send(message);
    });
  });
  return {
    calls: () => calls,
    delayNext: () => {
      delay = true;
    },
    failRefreshes: () => {
      failing = true;
    },
  };
}

realTest(
  "opening chats fetches no list and shows no placeholders, and the list keeps its place",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(120_000);
    let wire: ListWire | undefined;
    const page = await realApp.open({
      beforeLoad: async (opened) => {
        wire = await routeListSessions(opened);
        // Remember whether grey placeholder rows ever appear after the list has first loaded.
        await opened.addInitScript(() => {
          const seen = window as unknown as { __placeholders: number; __listLoaded: boolean };
          seen.__placeholders = 0;
          seen.__listLoaded = false;
          new MutationObserver(() => {
            if (document.querySelector('[role="listbox"][aria-label="Session list"]')) {
              seen.__listLoaded = true;
            }
            if (seen.__listLoaded && document.querySelector('[aria-label="Loading sessions"]')) {
              seen.__placeholders += 1;
            }
          }).observe(document, { childList: true, subtree: true });
        });
      },
    });
    if (wire === undefined) throw new Error("The list wire was not installed.");
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
    const callsAfterFirstLoad = wire.calls();
    expect(callsAfterFirstLoad).toBeGreaterThanOrEqual(1);

    await list.evaluate((element) => {
      element.scrollTop = 400;
    });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(400);

    // Open three different chats, each from rows fully in view (the list is about 380 px tall), so the
    // click itself does not scroll the list.
    for (const index of [9, 11, 13]) {
      const row = list.getByRole("option").nth(index);
      const label = (await row.innerText()).split("\n")[0] ?? "";
      await row.click();
      await expect(
        page.locator('[data-selected="true"]').filter({ hasText: label }).first(),
      ).toBeVisible({ timeout: 30_000 });
      // Give a refresh that should not happen time to show up.
      await page.waitForTimeout(800);
    }

    expect(wire.calls(), "opening chats must not fetch the list again").toBe(callsAfterFirstLoad);
    const placeholders = await page.evaluate(
      () => (window as unknown as { __placeholders: number }).__placeholders,
    );
    expect(placeholders, "grey placeholder rows appeared after the list had loaded").toBe(0);
    // The list is where the reader left it, although the sidebar is rebuilt as each chat opens.
    await expect
      .poll(() =>
        page
          .getByRole("listbox", { name: "Session list" })
          .evaluate((element) => element.scrollTop),
      )
      .toBe(400);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a refresh after a turn runs in the background, and a failed one keeps the rows",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(120_000);
    let wire: ListWire | undefined;
    const page = await realApp.open({
      beforeLoad: async (opened) => {
        wire = await routeListSessions(opened);
      },
    });
    if (wire === undefined) throw new Error("The list wire was not installed.");
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
    const composer = await startChat(page);
    const rows = () =>
      page.getByRole("listbox", { name: "Session list" }).getByRole("option").count();
    const rowsBefore = await rows();
    expect(rowsBefore).toBeGreaterThan(10);

    // A turn refreshes the list in the background; running-change and settled-turn signals may coalesce into one request.
    // Hold the next result for 3 s to check that the old rows stay visible without a placeholder.
    let calls = wire.calls();
    wire.delayNext();
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => wire?.calls()).toBeGreaterThanOrEqual(calls + 1);
    expect(await rows()).toBeGreaterThanOrEqual(rowsBefore);
    await expect(page.getByRole("status", { name: "Loading sessions" })).toHaveCount(0);
    // The held result arrives; the list is still there.
    await page.waitForTimeout(3_500);
    expect(await rows()).toBeGreaterThanOrEqual(rowsBefore);
    await expect(page.getByText("Couldn't refresh sessions. Showing the last list.")).toHaveCount(
      0,
    );

    // The next turn's refresh fails: the old list stays, with one line saying so.
    calls = wire.calls();
    wire.failRefreshes();
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await expect.poll(() => wire?.calls()).toBeGreaterThanOrEqual(calls + 1);
    const notice = page.getByText("Couldn't refresh sessions. Showing the last list.");
    await expect(notice).toBeVisible();
    // The whole sentence can be read: in the narrow sidebar it wraps onto a second line. It must
    // not end in an ellipsis ("Showing the last li…"), which is how it first shipped.
    const style = await notice.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { textOverflow: computed.textOverflow, whiteSpace: computed.whiteSpace };
    });
    expect(style.textOverflow).not.toBe("ellipsis");
    expect(style.whiteSpace).not.toBe("nowrap");
    expect(await rows()).toBeGreaterThanOrEqual(rowsBefore);
    await expect(page.getByRole("status", { name: "Loading sessions" })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "sessions-list", "refresh-failed.png") });
  },
);
