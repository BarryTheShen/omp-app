import {
  CHEVRON,
  centreOf,
  changesOf,
  distinctOf,
  endsOf,
  expectCardAnimates,
  expectPopupFades,
  expectSidebarSlides,
  fadesOf,
  LONG_CHAT,
  largestMoveOf,
  longTasksOf,
  type Measured,
  MODEL_DIALOG,
  measure,
  PALETTE,
  PROBES,
  REASONING_TRIGGER,
  readAudit,
  recordAudit,
  replyRow,
  round,
  settleTranscript,
  spanOf,
  summaryOf,
  TOKEN_SECONDS,
  TRACKED,
  takesBaseToken,
  trailOf,
} from "./motion-audit-recorder";
import { readLog, recordMotion } from "./motion-metrics";
import { expect, realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * The motion audit, measured again after its parts (#1173, part 7). Every row of the audit's table is measured in
 * one scripted real-omp flow on one long chat, and asserted against the criterion its part set, so a regression fails
 * the recorder. The baseline is the audit's comment of 2026-10-12 (main `fe60baa9`); the pull request puts the after
 * numbers beside it.
 *
 * Rows 14 and 15 (the long tasks of the first open and of start-up) are printed here, not asserted: #1640 owns their
 * criteria. Row 7 (the notices) runs in its own test, because that test starts omp with a fake extension. Row 16 (the
 * dead files) is a file check. A fourth test measures row 2 with the reader at the bottom, in a short chat, and asserts it.
 *
 * Each step is measured by `measure`. The sources of each criterion are the browser's own record, so a frame the machine
 * skipped does not change it: the length a transition or animation ran for (`transitionend`, `animationend`), its
 * declared duration (the computed style), the layout shift that no input caused (CLS), and the page's long tasks. The
 * frames in which a value changed are counted only where the criterion is that something moved at all.
 */
realTest.describe("the audit flow, one long chat", () => {
  realTest.use({ seedEntries: { entries: LONG_CHAT } });

  realTest("every row of the audit is measured and asserted", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(1_200_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(recordMotion, TRACKED);
        await target.addInitScript(recordAudit, PROBES);
      },
    });
    const measured: Measured[] = [];
    const step = (label: string, action: () => Promise<void>): Promise<Measured> =>
      measure(page, label, action).then((result) => {
        measured.push(result);
        return result;
      });

    // Row 15, start-up: what the page did before the app was drawn.
    const ready = await page.evaluate(() => performance.now());
    const boot = await readLog(page);
    const bootAudit = await readAudit(page);
    const startupShift = round(
      boot.shifts
        .filter((shift) => !shift.afterInput && shift.at <= ready)
        .reduce((sum, shift) => sum + shift.value, 0),
    );
    const startupBlock = Math.max(
      0,
      ...bootAudit.longTasks
        .filter((task) => task.at <= ready)
        .map((task) => Math.round(task.duration)),
    );
    expect
      .soft(startupShift, "row 15: layout shift that no input caused while the app starts")
      .toBeLessThan(0.02);

    // Row 14 and row 8: the long chat opens for the first time, and history that loads fades no message.
    const chatRow = page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option")
      .filter({ hasText: "Question 1" });
    const firstOpen = await step("row 14 first open of the long chat", async () => {
      await chatRow.click();
      await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
    });
    expect
      .soft(fadesOf(firstOpen)["message:enter"], "row 8: history that loads fades no message in")
      .toBeUndefined();

    // Row 8: a new chat's first prompt. Its message and reply fade in once each.
    const newChat = await step("row 8 a new chat's first reply", async () => {
      const composer = await startChat(page);
      await sendPrompt(composer, "pong");
      await expect(replyRow(page)).toContainText("pong", { timeout: 60_000 });
    });
    expect
      .soft(
        fadesOf(newChat)["message:enter"],
        "row 8: the new message and its reply fade in once each",
      )
      .toBe(2);

    // Row 14: switching back to the long chat.
    const back = await step("row 14 return to the long chat", async () => {
      await chatRow.click();
      await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
    });
    expect
      .soft(fadesOf(back)["message:enter"], "row 8: returning to history fades no message in")
      .toBeUndefined();

    // One bash call in the long chat: a tool card and a reasoning block, then a streamed reply below them.
    const composer = page.getByRole("textbox", { name: "Message input" });
    const stop = page.getByRole("button", { name: "Stop generating" });
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await sendPrompt(composer, "Please run_bash and tell me what it printed.");
    await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 60_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });

    // Row 1 and row 8: a streamed reply does not move the composer, and its two new rows fade in once each.
    const streamed = await step("row 1 a streamed reply", async () => {
      await sendPrompt(composer, "stream_long_code show the long block");
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Here is the long streamed block:")).toBeVisible();
      await expect(stop).toHaveCount(0, { timeout: 60_000 });
    });
    expect
      .soft(
        streamed.step.movedPx.composer ?? 0,
        "row 1: the composer's movement while the reply streams (px)",
      )
      .toBe(0);
    expect
      .soft(
        streamed.step.layoutShift,
        "row 1: layout shift that no input caused while the reply streams",
      )
      .toBeLessThan(0.02);
    expect
      .soft(
        fadesOf(streamed)["message:enter"],
        "row 8: the sent message and its reply fade in once each",
      )
      .toBe(2);

    // Row 13: the transcript scrolls up by 1500 px under the wheel, with no layout shift.
    const viewport = page.locator('[data-slot="u1-thread-viewport"]');
    const wheel = await step("row 13 scroll up 1500 px", async () => {
      await viewport.hover();
      await page.mouse.wheel(0, -1500);
      await expect(jump).toBeVisible({ timeout: 10_000 });
    });
    expect
      .soft(
        wheel.step.layoutShift,
        "row 13: layout shift that no input caused while the transcript scrolls",
      )
      .toBeLessThan(0.02);
    expect
      .soft(spanOf(wheel, "viewport"), "row 13: the scroll distance (px)")
      .toBeGreaterThanOrEqual(1000);

    // Row 9: Jump to latest scrolls at once, and the composer does not move.
    const jumped = await step("row 9 jump to latest", async () => {
      await jump.click();
      await expect(jump).toBeHidden({ timeout: 10_000 });
    });
    expect
      .soft(
        changesOf(jumped, "viewport"),
        "row 9: frames in which the transcript's scroll changes on the jump",
      )
      .toBeLessThanOrEqual(2);
    expect
      .soft(jumped.step.movedPx.composer ?? 0, "row 9: the composer's movement on the jump (px)")
      .toBe(0);
    expect
      .soft(changesOf(jumped, "viewport"), "row 9: the jump scrolls the transcript (frames)")
      .toBeGreaterThanOrEqual(1);
    expect
      .soft(largestMoveOf(jumped, "viewport"), "row 9: the jump's scroll in one frame (px)")
      .toBeGreaterThan(0);

    // Rows 3 and 4: the sessions and panels sidebars slide over the base token.
    const sessionsSidebar = page.locator('[data-shell-sidebar="left"]');
    const panelsSidebar = page.locator('[data-shell-sidebar="right"]');
    const sessionsHide = await step("row 3 sessions sidebar hides", async () => {
      await page.getByRole("button", { name: "Hide sessions sidebar" }).click();
      await expect(sessionsSidebar).toHaveAttribute("data-open", "false");
    });
    expectSidebarSlides(
      sessionsHide,
      "row 3",
      "sidebar:left",
      "sessionsSidebar",
      "the sessions sidebar hides",
    );
    const sessionsShow = await step("row 3 sessions sidebar shows", async () => {
      await page.getByRole("button", { name: "Show sessions sidebar" }).click();
      await expect(sessionsSidebar).toHaveAttribute("data-open", "true");
    });
    expectSidebarSlides(
      sessionsShow,
      "row 3",
      "sidebar:left",
      "sessionsSidebar",
      "the sessions sidebar shows",
    );
    // The panels sidebar starts closed on a first run (#2570), so it shows first, then hides.
    const panelsShow = await step("row 4 panels sidebar shows", async () => {
      await page.getByRole("button", { name: "Show panels sidebar" }).click();
      await expect(panelsSidebar).toHaveAttribute("data-open", "true");
    });
    expectSidebarSlides(
      panelsShow,
      "row 4",
      "sidebar:right",
      "panelsSidebar",
      "the panels sidebar shows",
    );
    const panelsHide = await step("row 4 panels sidebar hides", async () => {
      await page.getByRole("button", { name: "Hide panels sidebar" }).click();
      await expect(panelsSidebar).toHaveAttribute("data-open", "false");
    });
    expectSidebarSlides(
      panelsHide,
      "row 4",
      "sidebar:right",
      "panelsSidebar",
      "the panels sidebar hides",
    );

    // Row 5: the command palette fades and scales in and out over the base token.
    await composer.focus();
    const paletteOpen = await step("row 5 command palette opens", async () => {
      await page.keyboard.press("Control+k");
      await expect(page.locator(PALETTE)).toBeVisible();
    });
    const paletteClose = await step("row 5 command palette closes", async () => {
      await page.keyboard.press("Escape");
      await expect(page.locator(PALETTE)).toHaveCount(0);
    });
    expectPopupFades(
      paletteOpen,
      paletteClose,
      "row 5",
      "dialog:Command palette",
      "palette",
      "paletteDuration",
      "the command palette",
    );

    // Row 6: the model dialog fades in and out the same way.
    const modelButton = page.getByRole("button", {
      name: /Change model or thinking|Choose a model/,
    });
    const dialogOpen = await step("row 6 model dialog opens", async () => {
      await modelButton.click();
      await expect(page.locator(MODEL_DIALOG)).toBeVisible();
    });
    const dialogClose = await step("row 6 model dialog closes", async () => {
      await page.locator(MODEL_DIALOG).getByRole("button", { name: "Done" }).click();
      await expect(page.locator(MODEL_DIALOG)).toHaveCount(0);
    });
    expectPopupFades(
      dialogOpen,
      dialogClose,
      "row 6",
      "dialog:Model and thinking",
      "modelDialog",
      "modelDialogDuration",
      "the model dialog",
    );

    // Row 11: every visible button's transition takes a motion token (none takes the 150 ms default).
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => getComputedStyle(button).transitionDuration),
    );
    const parts = durations.flatMap((value) => value.split(",").map((part) => part.trim()));
    expect
      .soft(
        [...new Set(parts)].filter((value) => !TOKEN_SECONDS.includes(value)).sort(),
        "row 11: visible buttons whose transition takes no motion token",
      )
      .toEqual([]);

    // Row 12: typing runs no long task and no layout shift, measured on the app and not on the machine. The first keystroke
    // into an empty composer is measured on its own and printed (one head run had a 63 ms task there). The next 59 keystrokes
    // are typed in three windows of at most twenty, a second apart. On a busy machine a window can catch a long task that
    // typing did not cause, so the criterion is the best window: one window must run no long task. An app that runs a long
    // task on every keystroke fails all three windows; one that runs a long task on only some keystrokes is caught only when
    // every window has one.
    const text = "abcdefghij".repeat(6);
    await composer.click();
    await step("row 12 first keystroke into an empty composer", async () => {
      await composer.pressSequentially(text.slice(0, 1));
    });
    const chunks = [text.slice(1, 21), text.slice(21, 41), text.slice(41)];
    const windows: Measured[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0)
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
      windows.push(
        await step(`row 12 typing window ${index + 1} (${chunk.length} characters)`, async () => {
          await composer.pressSequentially(chunk);
        }),
      );
    }
    expect
      .soft(
        Math.min(...windows.map((typed) => longTasksOf(typed).length)),
        "row 12: long tasks (over 50 ms) while typing, in the best of the three windows",
      )
      .toBe(0);
    expect
      .soft(
        Math.max(...windows.map((typed) => typed.step.layoutShift)),
        "row 12: layout shift that no input caused while typing",
      )
      .toBeLessThan(0.02);
    await composer.fill("");

    // Row 8 and row 2: a reload. The long chat opens again with no fade of its messages, and its reader at the bottom.
    const beforeReload = await readAudit(page);
    await page.reload();
    const reopened = await step("row 8 reload and reopen the long chat", async () => {
      await chatRow.click();
      await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
    });
    expect
      .soft(fadesOf(reopened)["message:enter"], "row 8: a reload fades no message in")
      .toBeUndefined();
    const shortOfBottom = await settleTranscript(page);
    expect
      .soft(shortOfBottom, "the reader is at the bottom after the reload (px short of it)")
      .toBeLessThanOrEqual(4);

    // Row 2: the tool card (with the streamed reply below it) expands and collapses in place, with the reader above the
    // bottom. The card is brought into view first: a click on a card below the view would make Playwright scroll it
    // there, and that scroll would be counted as the card's own motion. The press is a mouse click at the centre of the
    // header, inside the measured step. An idle step first shows that nothing moves on its own.
    const card = page.locator('[data-slot="u3-tool-card-trigger"]').last();
    await card.scrollIntoViewIfNeeded();
    await settleTranscript(page);
    const idle = await step("row 2 control: the card in view, no input", async () => {
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
    });
    expect
      .soft(
        largestMoveOf(idle, "viewport"),
        "row 2 control: the transcript moves with no input (px)",
      )
      .toBe(0);
    expect
      .soft(largestMoveOf(idle, "cardTrigger"), "row 2 control: the card moves with no input (px)")
      .toBe(0);
    const press = await centreOf(card);
    const expand = await step("row 2 tool card expands, reader above the bottom", async () => {
      await page.mouse.click(press.x, press.y);
      await expect(card).toHaveAttribute("aria-expanded", "true");
    });
    expectCardAnimates(expand, "expands", false);
    expect
      .soft(
        largestMoveOf(expand, "viewport"),
        "row 2: the transcript's scroll while the card expands (px)",
      )
      .toBe(0);
    expect
      .soft(largestMoveOf(expand, "cardTrigger"), "row 2: the card's top while it expands (px)")
      .toBe(0);
    const collapsePress = await centreOf(card);
    const collapse = await step("row 2 tool card collapses, reader above the bottom", async () => {
      await page.mouse.click(collapsePress.x, collapsePress.y);
      await expect(card).toHaveAttribute("aria-expanded", "false");
    });
    expectCardAnimates(collapse, "collapses", true);
    expect
      .soft(
        largestMoveOf(collapse, "viewport"),
        "row 2: the transcript's scroll while the card collapses (px)",
      )
      .toBe(0);
    expect
      .soft(largestMoveOf(collapse, "cardTrigger"), "row 2: the card's top while it collapses (px)")
      .toBe(0);

    // Row 10: the reasoning chevron turns when its block opens and closes.
    const trigger = page.locator(REASONING_TRIGGER).first();
    const chevron = page.locator(CHEVRON).first();
    const turned = (): Promise<string> =>
      chevron.evaluate((element) => getComputedStyle(element).getPropertyValue("rotate"));
    const turnedBefore = await turned();
    const turnOne = await step("row 10 reasoning chevron, first toggle", async () => {
      await trigger.click();
      await waitForFiniteAnimations(page);
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    });
    expect
      .soft(await turned(), "row 10: the chevron turns when its reasoning block opens")
      .not.toBe(turnedBefore);
    const turnTwo = await step("row 10 reasoning chevron, second toggle", async () => {
      await trigger.click();
      await waitForFiniteAnimations(page);
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    });
    expect
      .soft(await turned(), "row 10: the chevron turns back when its block closes")
      .toBe(turnedBefore);
    for (const turn of [turnOne, turnTwo]) {
      expect
        .soft(
          takesBaseToken(endsOf(turn, undefined, "rotate")),
          `row 10: the chevron takes the base token (${turn.label})`,
        )
        .toBe(true);
      expect
        .soft(
          distinctOf(turn, "chevron"),
          `row 10: distinct chevron rotations while it turns (${turn.label})`,
        )
        .toBeGreaterThanOrEqual(3);
    }

    // Row 8 across the run: the seeded chat's row never fades in, and the new chat's row is recorded below.
    const afterReload = await readAudit(page);
    const sessionFades = [...beforeReload.fades, ...afterReload.fades].filter(
      (fade) => fade.key === "session:enter",
    );
    // The new chat's row is asserted in motion-audit-session-row.spec.ts (it fades in once). This flow records the
    // fades and asserts only that the seeded chat's row never fades.
    expect
      .soft(
        sessionFades.filter((fade) => fade.label.startsWith("Question")).length,
        "row 8: the seeded chat's row fades in on no visit",
      )
      .toBe(0);

    const report: Record<string, unknown> = {
      "row 15 start-up": { layoutShift: startupShift, longestBlockMs: startupBlock },
      "row 8 session fades across the run": sessionFades.map((fade) => [
        fade.label,
        Math.round(fade.at),
      ]),
      "row 8 session rows drawn": [...beforeReload.inserts, ...afterReload.inserts].map(
        (insert) => [insert.kind, insert.label],
      ),
      "row 5 palette close trail": trailOf(paletteClose, "palette"),
      "row 6 dialog close trail": trailOf(dialogClose, "modelDialog"),
      "row 2 expand trail": trailOf(expand, "cardContent"),
      "row 2 expand scroll height trail": trailOf(expand, "viewportHeight"),
      "row 2 collapse trail": trailOf(collapse, "cardContent"),
    };
    for (const entry of measured) report[entry.label] = summaryOf(entry);
    console.log(`AUDIT flow ${JSON.stringify(report)}`);
  });
});
