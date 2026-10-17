import {
  LONG_CHAT,
  PROBES,
  readAudit,
  recordAudit,
  replyRow,
  TRACKED,
} from "./motion-audit-recorder";
import { recordMotion } from "./motion-metrics";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Row 8 of the motion audit (#1858): a new chat's session row fades in once. The list is drawn again when the chat is
 * switched and on every catalog update after the reply; the page reports every fade it sees, and the new row must have
 * faded in exactly once.
 */
realTest.describe("session rows of the audit flow", () => {
  realTest.use({ seedEntries: { entries: LONG_CHAT } });

  realTest("row 8: a new chat's session row fades in once", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(900_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(recordMotion, TRACKED);
        await target.addInitScript(recordAudit, PROBES);
      },
    });
    const list = page.getByRole("listbox", { name: "Session list" });
    const chatRow = list.getByRole("option").filter({ hasText: "Question 1" });
    await chatRow.click();
    await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(replyRow(page)).toContainText("pong", { timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(list.getByRole("option").filter({ hasText: "pong" }).first()).toBeVisible();

    // The new chat's row is the one titled with its first prompt. The seeded rows are titled "Question N", and the page
    // gives a session row no id, so the title is the key.
    // Switch to the seeded chat and back: the list draws its rows again. The wait ends when the new row has faded in
    // a second time (the replay #1858 fixed), or when the list has updated twice since the reply without that
    // happening. Either way the page reports it; no fixed time is waited for.
    const updatesAfterReply = (await readAudit(page)).listUpdates;
    await chatRow.click();
    await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const audit = await readAudit(page);
          const pongFades = audit.fades.filter(
            (fade) => fade.key === "session:enter" && fade.label.startsWith("pong"),
          ).length;
          return pongFades >= 2 || audit.listUpdates - updatesAfterReply >= 2;
        },
        { timeout: 60_000, intervals: [250] },
      )
      .toBe(true);
    const audit = await readAudit(page);
    expect(
      audit.listUpdates - updatesAfterReply,
      "the list updated at least twice after the reply",
    ).toBeGreaterThanOrEqual(2);
    const newRowFades = audit.fades.filter(
      (fade) => fade.key === "session:enter" && fade.label.startsWith("pong"),
    );
    console.log(
      `AUDIT session row 8 ${JSON.stringify({
        listUpdates: audit.listUpdates - updatesAfterReply,
        fades: newRowFades.map((fade) => [fade.label, Math.round(fade.at)]),
      })}`,
    );

    // The recorder must have seen the row's first fade; otherwise a recorder that saw nothing would pass below.
    expect(
      newRowFades.length,
      "the recorder saw the new chat's row fade in",
    ).toBeGreaterThanOrEqual(1);
    expect(newRowFades.length, "row 8: the new chat's session row fades in once").toBe(1);
  });
});
