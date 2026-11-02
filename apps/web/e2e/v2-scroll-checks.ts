import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** A saved chat of about `bytes` of question and answer turns; its last answer starts with the returned marker. */
function longChat(bytes: number): {
  readonly entries: Record<string, unknown>[];
  readonly marker: string;
} {
  const answer = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(18);
  const base = Date.UTC(2026, 9, 20);
  const entries: Record<string, unknown>[] = [];
  let size = 0;
  let turn = 0;
  while (size < bytes) {
    turn += 1;
    const at = (offset: number) => new Date(base + turn * 2000 + offset).toISOString();
    const question = {
      type: "message",
      timestamp: at(0),
      message: { role: "user", content: `scroll question ${turn}`, timestamp: base + turn * 2000 },
    };
    const reply = {
      type: "message",
      timestamp: at(1000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `scroll answer ${turn}: ${answer}` }],
        api: "openai-completions",
        provider: "fake",
        model: "fake-model",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { total: 0 },
        },
        stopReason: "stop",
        timestamp: base + turn * 2000 + 1000,
      },
    };
    entries.push(question, reply);
    size += JSON.stringify(question).length + JSON.stringify(reply).length;
  }
  return { entries, marker: `scroll answer ${turn}:` };
}

const CHAT = longChat(5_000_000);

/** The first row on screen: its first words and its distance from the transcript's top edge. */
function topRow(page: Page): Promise<{ readonly text: string; readonly top: number } | null> {
  return page.evaluate(() => {
    const root = document.querySelector("section[aria-label='Transcript']");
    if (root === null) return null;
    const frame = root.getBoundingClientRect();
    const first = [...root.querySelectorAll<HTMLElement>(".tl-item")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > frame.top + 4 && rect.top < frame.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    return first === undefined
      ? null
      : {
          text: first.element.innerText.replace(/\s+/g, " ").slice(0, 60),
          top: first.rect.top - frame.top,
        };
  });
}

/** How far the transcript is from its end, in pixels. */
function fromEnd(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
    return root === null ? -1 : Math.round(root.scrollHeight - root.scrollTop - root.clientHeight);
  });
}

/** The transcript's scroll position, in pixels. */
function scrollTop(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>("section[aria-label='Transcript']")?.scrollTop ?? -1,
  );
}

/**
 * Waits until a wheel step's animation has ended: once the transcript has moved, its position the same over 4
 * animation frames in a row. Headless WebKit now and then stops drawing frames for over half a second in the middle of
 * a step, the page's timers running on, and the animation finishes once frames come back; a fixed wait read such a
 * step half done. A step that never moves (no room above) is read after 1 s; 3 s at most, frames or not.
 */
function settled(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
        if (root === null) {
          resolve();
          return;
        }
        const start = performance.now();
        setTimeout(resolve, 3000);
        const from = root.scrollTop;
        let last = from;
        let still = 0;
        let moved = false;
        const frame = (): void => {
          const top = root.scrollTop;
          if (top !== from) moved = true;
          still = top === last ? still + 1 : 0;
          last = top;
          if ((moved && still >= 4) || (!moved && performance.now() - start >= 1000)) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/**
 * Where the row whose text starts with `text` is, from the transcript's top edge, and its place in the list (it grows
 * when older entries load above); null when the row is not drawn.
 */
function rowPlace(
  page: Page,
  text: string,
): Promise<{ readonly top: number; readonly index: number } | null> {
  return page.evaluate((wanted) => {
    const root = document.querySelector("section[aria-label='Transcript']");
    if (root === null) return null;
    const match = [...root.querySelectorAll<HTMLElement>(".tl-item")].find((element) =>
      element.innerText.replace(/\s+/g, " ").startsWith(wanted),
    );
    return match === undefined
      ? null
      : {
          top: match.getBoundingClientRect().top - root.getBoundingClientRect().top,
          index: Number(match.dataset.index),
        };
  }, text);
}

/**
 * The transcript's scrolling in one engine (`browserName` is chosen at the top of the file that calls this): a live
 * chat shows its end, each wheel step up moves the line being read as far as the wheel asked while rows above are
 * measured, older entries loading above keep the line being read where it is, and a streaming reply changes only its
 * own row and stays at the bottom.
 */
export function defineScrollChecks(engine: string): void {
  realTest.describe(`new UI transcript scrolling, ${engine}`, () => {
    realTest.setTimeout(240_000);
    realTest.use({ seedEntries: { entries: CHAT.entries } });

    async function openLongChat(page: Page): Promise<void> {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /^scroll question 1/ })
        .click();
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText(CHAT.marker),
      ).toBeInViewport({
        timeout: 90_000,
      });
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        {
          timeout: 120_000,
        },
      );
    }

    realTest(
      "a live chat shows its end, and each wheel step up moves the line being read as far as it asks, also while older entries load above",
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(360_000);
        const page = await realApp.open({ path: "/" });
        await openLongChat(page);
        // The box and the working row grow as the chat goes live; the end stays in view.
        await expect.poll(() => fromEnd(page), { timeout: 5_000 }).toBeLessThanOrEqual(2);
        await page.getByRole("region", { name: "Transcript" }).hover();
        const short: string[] = [];
        /** One wheel step up, checked; true when older entries loaded above the line read during it. */
        const step = async (label: string): Promise<boolean> => {
          const before = await topRow(page);
          const was = before === null ? null : await rowPlace(page, before.text);
          // The room above when the step starts: older entries that load above during it add room, not movement.
          const room = await scrollTop(page);
          await page.mouse.wheel(0, -300);
          // WebKit animates a wheel step: read it once it has ended.
          await settled(page);
          const now = before === null ? null : await rowPlace(page, before.text);
          const moved = now === null || was === null ? null : Math.round(now.top - was.top);
          // A step moves as far as it asks; near the very top, at least as far as there was room.
          if (moved === null ? room > 0 : moved > 304 || moved < Math.min(300, room) - 4)
            short.push(`${label}: ${moved} px`);
          return now !== null && was !== null && now.index > was.index;
        };
        for (let n = 1; n <= 15; n += 1) await step(`from the end, step ${n}`);
        // Near the top of what is loaded, so that the next older entries load above in the middle of the steps.
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
          if (root !== null) root.scrollTop = 6000;
        });
        await page.waitForTimeout(1500);
        let loadedAt: number | null = null;
        for (let n = 1; n <= 60 && (loadedAt === null || n <= loadedAt + 5); n += 1) {
          if ((await step(`near the top, step ${n}`)) && loadedAt === null) loadedAt = n;
        }
        expect(loadedAt, "older entries loaded above during the steps").not.toBeNull();
        expect(short).toEqual([]);
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "opening a long chat reads none of its older entries until the reader scrolls up",
      async ({ realApp }) => {
        let olderReads = 0;
        const page = await realApp.open({
          path: "/",
          beforeLoad: async (opened) => {
            opened.on("websocket", (socket) =>
              socket.on("framesent", (frame) => {
                const text = typeof frame.payload === "string" ? frame.payload : "";
                if (text.includes('"method":"readEntryWindow"') && text.includes('"before"'))
                  olderReads += 1;
              }),
            );
          },
        });
        await openLongChat(page);
        await page.waitForTimeout(2_000);
        // An open reads the newest window only: older entries cost a phone's slow link a megabyte before it was live
        // (#2768).
        expect(olderReads).toBe(0);
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
          if (root !== null) root.scrollTop = 0;
        });
        await expect.poll(() => olderReads, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "older entries loading above keep the line being read where it is",
      async ({ realApp }) => {
        // The older entries are held back until the line read is taken, as over a slow link: they then land above a
        // line the reader is already reading. Without the hold a fast load lands first, and nothing is checked.
        let release = (): void => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let asked = false;
        const page = await realApp.open({
          path: "/",
          beforeLoad: (opened) =>
            opened.routeWebSocket(/\/ws/, (ws) => {
              const server = ws.connectToServer();
              const held = new Set<string>();
              ws.onMessage((message) => {
                const frame = JSON.parse(String(message)) as {
                  type?: string;
                  id?: unknown;
                  method?: string;
                  args?: { before?: unknown };
                };
                if (
                  frame.type === "call" &&
                  frame.method === "readEntryWindow" &&
                  frame.args?.before !== undefined
                ) {
                  held.add(String(frame.id));
                  asked = true;
                }
                server.send(message);
              });
              server.onMessage((message) => {
                const frame = JSON.parse(String(message)) as { type?: string; id?: unknown };
                if (frame.type === "result" && held.delete(String(frame.id))) {
                  void released.then(() => ws.send(message));
                  return;
                }
                ws.send(message);
              });
            }),
        });
        await openLongChat(page);
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
          if (root !== null) root.scrollTop = 0;
        });
        // At the top of what is loaded, the page asks for the next older entries.
        await expect.poll(() => asked, { timeout: 30_000 }).toBe(true);
        await page.waitForTimeout(300);
        const before = await topRow(page);
        expect(before).not.toBeNull();
        const text = before?.text ?? "";
        const was = await rowPlace(page, text);
        release();
        // They land above it: the line read is further down the list.
        await expect
          .poll(async () => (await rowPlace(page, text))?.index ?? -1, { timeout: 60_000 })
          .toBeGreaterThan(was?.index ?? 0);
        // Rows that land are measured over the next frames; the line read must not move meanwhile.
        await page.waitForTimeout(2000);
        const now = await rowPlace(page, text);
        expect(now).not.toBeNull();
        expect(Math.abs((now?.top ?? 0) - (before?.top ?? 0))).toBeLessThanOrEqual(2);
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "a streaming reply changes only its own row and stays at the bottom",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await openLongChat(page);
        const box = page.getByRole("textbox", { name: "Message" });
        await box.fill("stream_steady");
        await box.press("Enter");
        await expect(page.getByText(/Steady line 3:/)).toBeVisible({ timeout: 60_000 });
        const changes = await page.evaluate(async () => {
          const list = document.querySelector(".tl-item")?.parentElement ?? null;
          const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
          if (list === null || root === null) return null;
          let outside = 0;
          const observer = new MutationObserver((records) => {
            const last = Math.max(
              ...[...list.querySelectorAll<HTMLElement>(".tl-item")].map((element) =>
                Number(element.dataset.index),
              ),
            );
            for (const record of records) {
              const node =
                record.target instanceof Element ? record.target : record.target.parentElement;
              const item = node?.closest<HTMLElement>(".tl-item");
              if (item !== null && item !== undefined && Number(item.dataset.index) !== last)
                outside += 1;
            }
          });
          observer.observe(list, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          await new Promise((resolve) => setTimeout(resolve, 3000));
          observer.disconnect();
          return { outside, fromBottom: root.scrollHeight - root.scrollTop - root.clientHeight };
        });
        expect(changes?.outside).toBe(0);
        expect(changes?.fromBottom ?? 99).toBeLessThanOrEqual(2);
        await box.press("Escape");
        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
