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

/**
 * The transcript's scrolling in one engine (`browserName` is chosen at the top of the file that calls this): older
 * entries loading above keep the line being read where it is, and a streaming reply changes only its own row and
 * stays at the bottom.
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
      "older entries loading above keep the line being read where it is",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await openLongChat(page);
        // At the top of what is loaded, the next older entries load above: the list grows.
        const height = () =>
          page.evaluate(
            () =>
              document.querySelector(".tl-item")?.parentElement?.getBoundingClientRect().height ??
              0,
          );
        const start = await height();
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("section[aria-label='Transcript']");
          if (root !== null) root.scrollTop = 0;
        });
        await page.waitForTimeout(100);
        const before = await topRow(page);
        expect(before).not.toBeNull();
        await expect.poll(height, { timeout: 60_000 }).toBeGreaterThan(start);
        // Rows that land are measured over the next frames; the line read must not move meanwhile.
        await page.waitForTimeout(2000);
        const after = await page.evaluate((wanted) => {
          const root = document.querySelector("section[aria-label='Transcript']");
          if (root === null) return null;
          const match = [...root.querySelectorAll<HTMLElement>(".tl-item")].find((element) =>
            element.innerText.replace(/\s+/g, " ").startsWith(wanted),
          );
          return match === undefined
            ? null
            : match.getBoundingClientRect().top - root.getBoundingClientRect().top;
        }, before?.text ?? "");
        expect(after).not.toBeNull();
        expect(Math.abs((after ?? 0) - (before?.top ?? 0))).toBeLessThanOrEqual(2);
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
