import { describe, expect, test } from "vitest";
import { createSettingsClosedSignal } from "./settings-closed-signal";

describe("settings closed signal", () => {
  test("starts at zero and notifies subscribers with each bump", () => {
    const signal = createSettingsClosedSignal();
    const seen: number[] = [];
    const unsubscribe = signal.subscribe(() => seen.push(signal.count()));

    expect(signal.count()).toBe(0);
    signal.bump();
    signal.bump();

    expect(seen).toEqual([1, 2]);
    expect(signal.count()).toBe(2);
    unsubscribe();
    signal.bump();
    expect(seen).toEqual([1, 2]);
  });
});
