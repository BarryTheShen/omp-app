import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLimitsResult } from "@omp-app/contracts";
import { READINGS_KEEP_MS, UsageReadings } from "./readings";

const MIN = 60_000;
const START = Date.parse("2026-11-06T01:00:00Z");
const RESET = new Date(START + 4 * 60 * MIN).toISOString();

let folder: string | null = null;
afterEach(async () => {
  if (folder !== null) await rm(folder, { recursive: true, force: true });
  folder = null;
});

/** One read: Claude's 5-hour window at `used` percent, fetched at `at`. */
const read = (at: number, used: number): UsageLimitsResult => ({
  state: "ready",
  fetchedAt: new Date(at).toISOString(),
  providers: [
    {
      providerId: "anthropic",
      windows: [{ label: "5 Hour", usedPercent: used, resetsAt: RESET, accounts: 1 }],
    },
  ],
});

describe("usage readings and their pace (#2836)", () => {
  test("each window's pace from its readings; a cached read handed out again counts once", async () => {
    folder = await mkdtemp(join(tmpdir(), "omp-app-readings-"));
    const clock = { at: START };
    const readings = await UsageReadings.open(join(folder, "usage-readings.json"), {
      now: () => clock.at,
    });
    // 30% to 36% in 30 minutes: 12% an hour.
    for (let step = 0; step <= 6; step += 1) {
      clock.at = START + step * 5 * MIN;
      const result = read(clock.at, 30 + step);
      readings.add(result);
      readings.add(result);
    }
    const [window] = readings.pace().windows;
    expect(window?.providerId).toBe("anthropic");
    expect(window?.label).toBe("5 Hour");
    expect(window?.readings).toBe(7);
    expect(window?.perHour).toBeCloseTo(12, 6);
    // Full at 100% in (100 - 36) / 12 hours, past the reset 3.5 hours away: how full at the reset.
    expect(window?.fullAt).toBeNull();
    expect(window?.atReset).toBeCloseTo(36 + 12 * 3.5, 6);
  });

  test("the readings outlast a restart, and a day's are kept", async () => {
    folder = await mkdtemp(join(tmpdir(), "omp-app-readings-"));
    const path = join(folder, "usage-readings.json");
    const clock = { at: START };
    const first = await UsageReadings.open(path, { now: () => clock.at });
    first.add(read(START, 10));
    clock.at = START + 30 * MIN;
    first.add(read(clock.at, 12));
    await first.saved();

    const again = await UsageReadings.open(path, { now: () => clock.at });
    expect(again.pace().windows.map((window) => window.readings)).toEqual([2]);

    // A day after the first reading it is gone; the second, half an hour younger, is kept.
    clock.at = START + READINGS_KEEP_MS + MIN;
    const later = await UsageReadings.open(path, { now: () => clock.at });
    expect(later.pace().windows.map((window) => window.readings)).toEqual([1]);
  });

  test("a window's history is its day of readings, oldest first, without the ones older than a day", async () => {
    folder = await mkdtemp(join(tmpdir(), "omp-app-readings-"));
    const clock = { at: START };
    const readings = await UsageReadings.open(join(folder, "usage-readings.json"), {
      now: () => clock.at,
    });
    readings.add(read(START, 10));
    clock.at = START + 30 * MIN;
    readings.add(read(clock.at, 14));
    expect(readings.history()).toEqual({
      windows: [
        {
          providerId: "anthropic",
          label: "5 Hour",
          readings: [
            [START, 10],
            [START + 30 * MIN, 14],
          ],
        },
      ],
    });
    clock.at = START + READINGS_KEEP_MS + MIN;
    expect(readings.history().windows[0]?.readings).toEqual([[START + 30 * MIN, 14]]);
  });
});
