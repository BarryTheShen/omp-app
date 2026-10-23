import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.use({ seedSessions: 100 });

/**
 * Issue 664: a chat switch reads no list, and the clicked chat's row shows as the selected one at once, while omp
 * is still opening the chat. The page's WebSocket is routed here: the result of each chat open is held until the
 * test releases it, so the row is checked while its chat is still opening, and no timer decides the outcome.
 *
 * Per click it records `paintMs` (the click to the row being the selected one, on the page's clock), `listReads`
 * (the `listSessions` calls sent from the click until the switch has settled), `opens` (the chat opens sent for the
 * click) and `rowsRemounted` (rows of the list replaced by new elements during the switch).
 *
 * Two tests. A switch between chats that run no turn reads no list at all. A switch while a turn runs in the chat on
 * screen keeps the rows and selects the row at once, and its list reads are only bounded: the server announces each
 * start and end of a turn, and the list reads again for each (#1878).
 */
/** A late list read would arrive after the chat's result, so each switch is watched this long before it is counted. */
const SETTLE_MS = 800;
const MAX_PAINT_MS = 300;
/** Rows clicked in turn; with the list scrolled to 400 px each is fully in view (the list is about 380 px tall). */
const ROW_INDEXES = [9, 11, 13];
/** The row clicked last, in the narrow layout, where the list is in the sessions drawer. */
const NARROW_ROW_INDEX = 15;

interface Wire {
  /** How many `listSessions` calls the page has sent. */
  readonly listReads: () => number;
  /** How many chat opens (`A0.rpcSession.open`) the page has sent. */
  readonly opensSent: () => number;
  /** How many chat opens have had their response delivered to the page. */
  readonly opensDelivered: () => number;
  /** How many answered chat opens are waiting to be delivered. */
  readonly heldCount: () => number;
  /** Holds the responses of the chat opens that arrive from now on, until `release`. */
  readonly hold: () => void;
  /** Delivers the held responses, and lets the later ones through at once. */
  readonly release: () => void;
  /** What the wire saw of the chat opens, for the report when a switch fails. */
  readonly log: () => string;
}

interface Switch {
  readonly title: string;
  readonly paintMs: number;
  readonly listReads: number;
  readonly opens: number;
  readonly rowsRemounted: number;
}

/** The `id` of a JSON frame, when the text is an object with a string id; undefined for any other text. */
function frameId(text: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof frame === "object" &&
    frame !== null &&
    "id" in frame &&
    typeof frame.id === "string"
    ? frame.id
    : undefined;
}

/** Routes the page's WebSocket: counts list calls and chat opens, and holds each open's response while asked to. */
async function routeWire(page: Page): Promise<Wire> {
  let listReads = 0;
  let opensSent = 0;
  let opensDelivered = 0;
  let holding = false;
  const openIds = new Set<string>();
  const held: Array<() => void> = [];
  const log: string[] = [];
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") {
        if (message.includes('"method":"listSessions"')) listReads += 1;
        if (message.includes('"port":"A0.rpcSession"') && message.includes('"method":"open"')) {
          const id = frameId(message);
          if (id !== undefined) {
            openIds.add(id);
            opensSent += 1;
            log.push(`sent open ${id} (holding: ${holding})`);
          }
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === "string" && openIds.size > 0) {
        const id = frameId(message);
        if (id !== undefined && openIds.delete(id)) {
          log.push(`response to open ${id} (holding: ${holding}): ${message.slice(0, 200)}`);
          const deliver = () => {
            opensDelivered += 1;
            ws.send(message);
          };
          if (holding) held.push(deliver);
          else deliver();
          return;
        }
      }
      ws.send(message);
    });
  });
  return {
    listReads: () => listReads,
    opensSent: () => opensSent,
    opensDelivered: () => opensDelivered,
    heldCount: () => held.length,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
    log: () => log.join("\n"),
  };
}

/** The row the page shows as selected has its style: a transparent background would mean the style did not load. */
async function expectSelectedRowStyled(page: Page, title: string): Promise<void> {
  const row = page.locator(
    '[role="listbox"][aria-label="Session list"] [data-slot="r1-session-row"][data-selected="true"]',
  );
  await expect(row).toContainText(title);
  expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
}

/**
 * Clicks a row and returns once its switch is over. The chat's open is held while the row is checked and
 * `whileOpening` runs: the row must be selected by then, and no response of the chat may have arrived.
 */
async function switchTo(
  page: Page,
  wire: Wire,
  list: Locator,
  index: number,
  title: string,
  whileOpening?: () => Promise<void>,
): Promise<Switch> {
  const readsBefore = wire.listReads();
  const opensBefore = wire.opensSent();
  const deliveredBefore = wire.opensDelivered();
  // Marks each row now shown, so a row replaced by a new element during the switch can be counted.
  const rowsBefore = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      '[role="listbox"][aria-label="Session list"] [role="option"]',
    );
    for (const row of rows) row.setAttribute("data-marked", "");
    return rows.length;
  });
  const option = list.getByRole("option").nth(index);
  await expect(option).toContainText(title);
  wire.hold();
  await option.click();
  const selected = await page
    .waitForFunction(
      (label) => {
        const row = document.querySelector<HTMLElement>(
          '[role="listbox"][aria-label="Session list"] [data-slot="r1-session-row"][data-selected="true"]',
        );
        return row?.textContent?.includes(label) ? Date.now() : false;
      },
      title,
      { polling: "raf", timeout: 15_000 },
    )
    .catch(() => {
      throw new Error(
        `${title}: the clicked row was not selected while its chat was still opening`,
      );
    });
  const selectedAt = Number(await selected.jsonValue());
  expect(
    wire.opensDelivered(),
    `${title}: the row was selected only after its chat had opened`,
  ).toBe(deliveredBefore);
  if (whileOpening) await whileOpening();
  wire.release();
  // The switch is over when the chat's open has had its response. Opening a chat starts omp, which can take seconds
  // while other runs share the machine, so both waits are bounded by a long timeout rather than the default.
  await expect
    .poll(() => wire.opensSent(), {
      message: `${title}: the click sent no chat open`,
      timeout: 60_000,
    })
    .toBeGreaterThan(opensBefore);
  await expect
    .poll(() => wire.opensSent() - wire.opensDelivered(), {
      message: `${title}: a chat open has no response`,
      timeout: 60_000,
    })
    .toBe(0);
  const clickedAt = Number(await page.evaluate(() => document.documentElement.dataset.clickedAt));
  await page.waitForTimeout(SETTLE_MS);
  const rowsKept = await page.evaluate(
    () =>
      document.querySelectorAll('[role="listbox"][aria-label="Session list"] [data-marked]').length,
  );
  return {
    title,
    paintMs: selectedAt - clickedAt,
    listReads: wire.listReads() - readsBefore,
    opens: wire.opensSent() - opensBefore,
    rowsRemounted: rowsBefore - rowsKept,
  };
}

/** Stamps each click on the page's own clock, so the paint time is measured where the row is drawn. */
async function stampClicks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      () => {
        document.documentElement.dataset.clickedAt = String(Date.now());
      },
      true,
    );
  });
}

realTest(
  "a switch between chats that run no turn reads no list and keeps the rows",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const wires: Wire[] = [];
    const page = await realApp.open({
      beforeLoad: async (opened) => {
        wires.push(await routeWire(opened));
        await stampClicks(opened);
      },
    });
    const wire = wires[0];
    if (wire === undefined) throw new Error("The socket wire was not installed.");
    const list = page.getByRole("listbox", { name: "Session list" });
    const perClick: Switch[] = [];
    try {
      await list.getByRole("option").nth(0).click();
      await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(SETTLE_MS);
      await list.evaluate((element) => {
        element.scrollTop = 400;
      });
      for (const index of ROW_INDEXES) {
        const title = (await list.getByRole("option").nth(index).innerText()).split("\n")[0] ?? "";
        perClick.push(await switchTo(page, wire, list, index, title));
      }
      testInfo.annotations.push({ type: "fix-664", description: JSON.stringify(perClick) });
      for (const click of perClick) {
        expect(click.listReads, `${click.title}: the switch read the list again`).toBe(0);
        expect(click.rowsRemounted, `${click.title}: the Sessions rows remounted`).toBe(0);
        expect(
          click.paintMs,
          `${click.title}: the row took too long to show as selected`,
        ).toBeLessThan(MAX_PAINT_MS);
      }
      expect(realApp.problems).toEqual([]);
    } catch (error) {
      await testInfo.attach("chat-open-wire.txt", { body: wire.log(), contentType: "text/plain" });
      throw error;
    }
  },
);

realTest(
  "a switch while a turn runs keeps the rows, selects the clicked row at once and bounds the list reads, while the chat is still opening",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const wires: Wire[] = [];
    const page = await realApp.open({
      beforeLoad: async (opened) => {
        wires.push(await routeWire(opened));
        await stampClicks(opened);
      },
    });
    const wire = wires[0];
    if (wire === undefined) throw new Error("The socket wire was not installed.");
    const list = page.getByRole("listbox", { name: "Session list" });
    const perClick: Switch[] = [];
    try {
      await list.getByRole("option").nth(0).click();
      await expect(list.locator('[data-slot="r1-session-row"][data-selected="true"]')).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(SETTLE_MS);
      const composer = page.getByRole("textbox", { name: "Message input" });
      await list.evaluate((element) => {
        element.scrollTop = 400;
      });
      await composer.fill("slow_tool switch stream");
      await composer.press("Enter");
      await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
        timeout: 60_000,
      });

      for (const [position, index] of ROW_INDEXES.entries()) {
        const title = (await list.getByRole("option").nth(index).innerText()).split("\n")[0] ?? "";
        // Kind: acts on the running turn (its chat is left while it runs, and the rows are read). Since issue 2212 the page
        // opens the picked chat first: the first open is held here, while the picked chat is on screen with its composer
        // blocked and a send held back with its text. The sidebar's own open of the chat follows once this step returns.
        const whileOpening =
          position === 0
            ? async () => {
                const blocked = page.locator('[data-composer-blocked="true"]');
                await expect(blocked).toContainText("Opening session");
                await composer.fill("typed while switching");
                await composer.press("Enter");
                await expect(composer).toHaveValue("typed while switching");
                await expectSelectedRowStyled(page, title);
                await page.emulateMedia({ colorScheme: "light" });
                await waitForFiniteAnimations(page);
                await page.screenshot({
                  path: join(screenshots, "fix-664-switching-light.png"),
                  fullPage: true,
                });
                await page.emulateMedia({ colorScheme: "dark" });
                await expect(page.locator("html")).toHaveClass(/dark/);
                await expectSelectedRowStyled(page, title);
                await waitForFiniteAnimations(page);
                await page.screenshot({
                  path: join(screenshots, "fix-664-switching-dark.png"),
                  fullPage: true,
                });
                await page.emulateMedia({ colorScheme: "light" });
                await expect(page.locator("html")).not.toHaveClass(/dark/);
                await expect.poll(() => wire.heldCount(), { timeout: 60_000 }).toBeGreaterThan(0);
              }
            : undefined;
        perClick.push(await switchTo(page, wire, list, index, title, whileOpening));
      }
      const scrollAfterWide = await list.evaluate((element) => element.scrollTop);

      // At 390 px the list is in the sessions drawer, and the drawer stays open when a chat is picked.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Show sessions sidebar" }).click();
      await expect(list.getByRole("option").first()).toBeVisible();
      const narrowTitle =
        (await list.getByRole("option").nth(NARROW_ROW_INDEX).innerText()).split("\n")[0] ?? "";
      perClick.push(
        await switchTo(page, wire, list, NARROW_ROW_INDEX, narrowTitle, async () => {
          await expectSelectedRowStyled(page, narrowTitle);
          await waitForFiniteAnimations(page);
          await page.screenshot({
            path: join(screenshots, "fix-664-opening-narrow.png"),
            fullPage: true,
          });
        }),
      );

      testInfo.annotations.push({ type: "fix-664", description: JSON.stringify(perClick) });
      for (const click of perClick) {
        expect(
          click.listReads,
          `${click.title}: running-turn list refreshes are bounded`,
        ).toBeLessThanOrEqual(2);
        expect(click.rowsRemounted, `${click.title}: the Sessions rows remounted`).toBe(0);
        expect(
          click.paintMs,
          `${click.title}: the row took too long to show as selected`,
        ).toBeLessThan(MAX_PAINT_MS);
      }
      expect(scrollAfterWide, "the list lost its place").toBe(400);
      expect(realApp.problems).toEqual([]);
    } catch (error) {
      await testInfo.attach("chat-open-wire.txt", { body: wire.log(), contentType: "text/plain" });
      throw error;
    }
  },
);
