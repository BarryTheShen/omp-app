import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/** A saved chat of `turns` question and answer turns, long enough that its list draws only the rows near the view. */
function longChat(turns: number): Record<string, unknown>[] {
  const answer = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(18);
  const base = Date.UTC(2026, 9, 20);
  const entries: Record<string, unknown>[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const at = (offset: number) => new Date(base + turn * 2000 + offset).toISOString();
    entries.push(
      {
        type: "message",
        timestamp: at(0),
        message: {
          role: "user",
          content: `switch question ${turn}`,
          timestamp: base + turn * 2000,
        },
      },
      {
        type: "message",
        timestamp: at(1000),
        message: {
          role: "assistant",
          content: [{ type: "text", text: `switch answer ${turn}: ${answer}` }],
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
      },
    );
  }
  return entries;
}

/** How many of the shown workspace's transcript rows are on screen. */
function rowsInView(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      "[data-tab]:not([data-hidden]) section[aria-label='Transcript']",
    );
    if (root === null) return -1;
    const frame = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>(".tl-item")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.bottom > frame.top && rect.top < frame.bottom).length;
  });
}

/**
 * Switching workspaces quickly while a chat streams (#2832): a workspace not shown kept `display: none`, its chat's list
 * was measured at 0 and back at each switch, and it then drew its rows for a scroll place it no longer had: the chat
 * showed blank, its scroll bar at the end.
 */
export function defineWorkspaceSwitch(engine: string): void {
  realTest.describe(`new UI workspace switching, ${engine}`, () => {
    realTest.setTimeout(240_000);
    realTest.use({ seedEntries: { entries: longChat(400) } });

    realTest(
      "switching workspaces quickly while a chat streams leaves its transcript drawn (#2832)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await page.setViewportSize({ width: 1280, height: 860 });
        await page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: /^switch question 1/ })
          .click();
        const box = page.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await expect(page.getByText(/switch answer 400:/)).toBeVisible({ timeout: 60_000 });
        await box.fill("stream_steady");
        await box.press("Enter");
        await expect(page.getByText(/Steady line 1:/)).toBeVisible({ timeout: 60_000 });
        await page.keyboard.press("Control+t");
        await page.keyboard.press("Control+t");
        const tabs = page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab");
        await expect(tabs).toHaveCount(3);
        await tabs.nth(0).click();
        await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
        // Rounds of three quick presses, each back to the chat's workspace.
        const blank: number[] = [];
        for (let round = 0; round < 30; round += 1) {
          for (let press = 0; press < 3; press += 1) {
            await page.keyboard.press("Control+Tab");
            await page.waitForTimeout(40);
          }
          await page.waitForTimeout(300);
          if ((await rowsInView(page)) <= 0) blank.push(round);
        }
        expect(blank).toEqual([]);
        await box.press("Escape");
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "a workspace not shown paints nothing: its windows and dividers stay out of sight (#2834)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await page.setViewportSize({ width: 1280, height: 860 });
        await startNewChat(page);
        const box = page.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        // A split: the chat and a blank window beside it, a divider between them.
        await page.keyboard.press("Control+Shift+O");
        const shownBlank = page.locator("[data-tab]:not([data-hidden]) [data-blank-window]");
        await expect(shownBlank).toHaveCount(1);
        await page.keyboard.press("Control+t");
        const tabs = page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab");
        await expect(tabs).toHaveCount(2);
        await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
        const seen = await page.evaluate(() => {
          const hidden = [...document.querySelectorAll<HTMLElement>("[data-tab][data-hidden]")];
          let visible = 0;
          for (const tab of hidden)
            for (const element of [tab, ...tab.querySelectorAll<HTMLElement>("*")])
              for (const part of [null, "::before", "::after"])
                if (getComputedStyle(element, part).visibility === "visible") visible += 1;
          return {
            hidden: hidden.length,
            dividers: hidden.reduce((sum, tab) => sum + tab.querySelectorAll(".dv-sash").length, 0),
            visible,
          };
        });
        // The workspace behind holds its split, and nothing of it, the divider included, is visible.
        expect(seen.hidden).toBe(1);
        expect(seen.dividers).toBeGreaterThan(0);
        expect(seen.visible).toBe(0);
        // In front again, its chat and its blank window show.
        await page.keyboard.press("Control+Tab");
        await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
        await expect(box).toBeVisible();
        await expect(shownBlank).toBeVisible();
        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
