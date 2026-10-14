import { describe, expect, test } from "vitest";
import { ActiveTimeMeter } from "../../status/active-time";

describe("ActiveTimeMeter", () => {
  test("counts only the time omp is working, not the idle time around it", () => {
    const meter = new ActiveTimeMeter();
    meter.observe(true, 1_000);
    expect(meter.activeMs(4_000)).toBe(3_000);
    meter.observe(false, 5_000);
    expect(meter.activeMs(60_000)).toBe(4_000);
  });

  test("a working state that repeats does not restart the open window", () => {
    const meter = new ActiveTimeMeter();
    meter.observe(true, 1_000);
    meter.observe(true, 2_000);
    expect(meter.activeMs(3_000)).toBe(2_000);
  });

  test("an end with no open window changes nothing", () => {
    const meter = new ActiveTimeMeter();
    meter.observe(false, 1_000);
    expect(meter.activeMs(2_000)).toBe(0);
  });

  test("separate turns add up", () => {
    const meter = new ActiveTimeMeter();
    meter.observe(true, 0);
    meter.observe(false, 2_000);
    meter.observe(true, 10_000);
    meter.observe(false, 13_000);
    expect(meter.activeMs(99_000)).toBe(5_000);
  });

  test("a clock that moves backwards adds nothing", () => {
    const meter = new ActiveTimeMeter();
    meter.observe(true, 5_000);
    meter.observe(false, 4_000);
    expect(meter.activeMs(9_000)).toBe(0);
  });
});
