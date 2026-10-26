import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BASE,
  endsOf,
  inWindow,
  type Measured,
  measure,
  NOTICE_PROBES,
  recordAudit,
  round,
  showedIn,
  summaryOf,
  TRACKED,
  takesBaseToken,
  trailOf,
} from "./motion-audit-recorder";
import { readLog, recordMotion } from "./motion-metrics";
import {
  APP_ROOT,
  expect,
  realTest,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

// Row 7: the notices line and a toast fade in and out. The extension sends three informational notices and a warning (a
// toast) when a turn starts, so they arrive while the chat is on screen, and each one fades in as it arrives.
const EXTENSION_FILE = "motion-audit-notices.ts";
const NOTION_MOUNT = "xd://: mounted mcp__notion_fetch, mcp__notion_search";
const CALENDAR_MOUNT = "xd://: mounted mcp__google_calendar_list_events";
const CACHE_NOTICE = "Build cache warmed";
const DISK_WARNING = "Disk is almost full on the build volume";
const EXTENSION_SOURCE = `export default function auditNotices(pi) {
  pi.on("turn_start", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(NOTION_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CALENDAR_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CACHE_NOTICE)}, "info");
    ctx.ui.notify(${JSON.stringify(DISK_WARNING)}, "warning");
  });
}
`;
// A chat does not load a file seeded in the agent's extensions folder here, but it loads any file named with `--extension`.
const DATA_DIR = resolve(APP_ROOT, ".data");
const OMP_WITH_EXTENSION = join(DATA_DIR, "motion-audit-omp-with-extension.sh");

realTest.describe("row 7, the notices", () => {
  // The wrapper script is written before this block's tests run, not when the file loads.
  realTest.beforeAll(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      OMP_WITH_EXTENSION,
      `#!/bin/sh\nexec "$@" --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}"\n`,
    );
    chmodSync(OMP_WITH_EXTENSION, 0o755);
  });
  realTest.use({
    chatWrapper: OMP_WITH_EXTENSION,
    seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
  });

  realTest(
    "the notices line and a toast fade in and out over the base token",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(600_000);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.addInitScript(recordMotion, TRACKED);
          await target.addInitScript(recordAudit, NOTICE_PROBES);
        },
      });
      const composer = await startChat(page);
      // A notice counts as live only after the page's first two seconds (`NOTICE_SETTLE_MS`, lib/motion.ts): a notice that
      // arrives before then is a start-up notice, drawn without a fade. So the turn that sends the notices waits until the
      // page is three seconds old and its notices panel has drawn.
      await expect(page.getByTestId("n1-notices")).toBeAttached({ timeout: 30_000 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, Math.max(0, 3000 - performance.now()));
          }),
      );
      await waitForFiniteAnimations(page);
      const arrived = await measure(page, "row 7 notices arrive with a turn", async () => {
        // A slow tool turn: its reply lands 30 s later, after the notices' fades, so the reply's own layout is not measured here.
        await sendPrompt(composer, "slow_tool 30");
        await expect(page.getByRole("button", { name: "3 notices from omp" })).toBeVisible({
          timeout: 60_000,
        });
        await expect(page.getByText(DISK_WARNING).first()).toBeVisible({ timeout: 60_000 });
      });
      const dismissLine = page.getByRole("button", { name: "Dismiss notices from omp" });
      const quietLeave = await measure(page, "row 7 notices line dismissed", async () => {
        await dismissLine.click();
        await expect(page.getByTestId("n1-quiet")).toBeHidden();
      });
      const dismissToast = page.getByRole("button", { name: "Dismiss notification" });
      const toastsBefore = await dismissToast.count();
      const toastLeave = await measure(page, "row 7 toast dismissed", async () => {
        await dismissToast.first().click();
        await expect(dismissToast).toHaveCount(toastsBefore - 1);
      });

      expect
        .soft(
          takesBaseToken(endsOf(arrived, "n1-quiet", "opacity")),
          "row 7: the notices line takes the base token to appear",
        )
        .toBe(true);
      expect
        .soft(
          takesBaseToken(endsOf(arrived, "notice:toast", "opacity")),
          "row 7: the toast takes the base token to appear",
        )
        .toBe(true);
      expect
        .soft(
          showedIn(quietLeave, "quietDuration", BASE),
          "row 7: the notices line exits over the base token",
        )
        .toBe(true);
      expect
        .soft(
          quietLeave.audit.animations.some(
            (animation) =>
              animation.kind === "run" &&
              animation.name === "n1-quiet" &&
              inWindow(quietLeave, animation.at),
          ),
          "row 7: the notices line starts its exit fade",
        )
        .toBe(true);
      expect
        .soft(
          showedIn(toastLeave, "toastDuration", BASE),
          "row 7: the toast exits over the base token",
        )
        .toBe(true);
      expect
        .soft(
          toastLeave.audit.animations.some(
            (animation) =>
              animation.kind === "run" &&
              animation.name === "notice:toast" &&
              inWindow(toastLeave, animation.at),
          ),
          "row 7: the toast starts its exit fade",
        )
        .toBe(true);
      // The notices' own motion runs from their first fade to the last one's end. The turn's reply can move the composer
      // before the notices arrive (in every run that failed, the reply landed first), so the criterion reads that span only.
      const noticeNames = ["n1-quiet", "notice:toast"];
      const noticeRuns = arrived.audit.animations.filter(
        (animation) => animation.kind === "run" && noticeNames.includes(animation.name),
      );
      const noticeEnds = arrived.audit.ends.filter((end) => noticeNames.includes(end.name));
      expect(noticeRuns.length, "row 7: the notices' fade-in is recorded").toBeGreaterThan(0);
      expect(noticeEnds.length, "row 7: the notices' fade-out is recorded").toBeGreaterThan(0);
      const noticesFrom = Math.min(...noticeRuns.map((animation) => animation.at));
      const noticesTo = Math.max(...noticeEnds.map((end) => end.at));
      const noticesShift = round(
        (await readLog(page)).shifts
          .filter((shift) => !shift.afterInput && shift.at >= noticesFrom && shift.at <= noticesTo)
          .reduce((sum, shift) => sum + shift.value, 0),
      );
      expect
        .soft(noticesShift, "row 7: layout shift that no input caused (arrived)")
        .toBeLessThan(0.02);
      const checked: [string, Measured][] = [
        ["quiet leave", quietLeave],
        ["toast leave", toastLeave],
      ];
      for (const [label, entry] of checked) {
        expect
          .soft(entry.step.layoutShift, `row 7: layout shift that no input caused (${label})`)
          .toBeLessThan(0.02);
      }
      console.log(
        `AUDIT notices ${JSON.stringify({
          pageMsAtArrival: Math.round(arrived.startMs),
          arrived: summaryOf(arrived),
          quietLeave: summaryOf(quietLeave),
          toastLeave: summaryOf(toastLeave),
          toastTrail: trailOf(arrived, "toast"),
          quietTrail: trailOf(arrived, "quiet"),
        })}`,
      );
    },
  );
});
