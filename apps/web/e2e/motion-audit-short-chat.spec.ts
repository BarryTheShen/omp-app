import {
  changesOf,
  endsOf,
  largestMoveOf,
  measure,
  PROBES,
  recordAudit,
  settleTranscript,
  TRACKED,
} from "./motion-audit-recorder";
import { recordMotion } from "./motion-metrics";
import { expect, realTest } from "./real-omp";

// Row 2 with the reader at the bottom: a card that expands in a short chat (the audit's own three-card chat), measured
// the way the flow measures it and asserted. Here the reader follows the bottom, the case the audit described.
realTest.describe("row 2, a short chat with the reader at the bottom", () => {
  realTest.use({ seedLongTurn: 3 });

  realTest(
    "a card expands at the reader's bottom in a short chat",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.addInitScript(recordMotion, TRACKED);
          await target.addInitScript(recordAudit, PROBES);
        },
      });
      await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
      await expect(page.getByText("All 3 steps are done.")).toBeVisible({ timeout: 60_000 });
      const shortOfBottom = await settleTranscript(page);
      expect
        .soft(
          shortOfBottom,
          "row 2: the reader is at the bottom before the card expands (px short of it)",
        )
        .toBeLessThanOrEqual(4);
      const card = page.locator('[data-slot="u3-tool-card-trigger"]').last();
      const expand = await measure(page, "row 2 short chat, the last card expands", async () => {
        await card.click();
        await expect(card).toHaveAttribute("aria-expanded", "true");
      });
      expect
        .soft(
          largestMoveOf(expand, "viewport"),
          "row 2: the transcript's scroll while the card expands (px)",
        )
        .toBe(0);
      expect
        .soft(largestMoveOf(expand, "cardTrigger"), "row 2: the card's top while it expands (px)")
        .toBe(0);
      console.log(
        `AUDIT short ${JSON.stringify({
          shortOfBottom,
          transcriptMovePx: largestMoveOf(expand, "viewport"),
          cardMovePx: largestMoveOf(expand, "cardTrigger"),
          contentFrames: changesOf(expand, "cardContent"),
          grid: endsOf(expand, undefined, "grid-template-rows"),
          layoutShift: expand.step.layoutShift,
        })}`,
      );
    },
  );
});
