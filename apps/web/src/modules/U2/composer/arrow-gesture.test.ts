import { describe, expect, test } from "vitest";
import { arrowGestureStep, DOUBLE_LEFT_MS, NO_ARROW_GESTURE } from "./arrow-gesture";

const KEYS = { left: "ArrowLeft", other: "a" } as const;

function press(
  gesture: typeof NO_ARROW_GESTURE,
  key: string,
  now: number,
  options: { readonly emptyEditor?: boolean; readonly repeat?: boolean } = {},
) {
  return arrowGestureStep(gesture, {
    key,
    repeat: options.repeat ?? false,
    emptyEditor: options.emptyEditor ?? true,
    now,
  });
}

describe("double-tap left arrow", () => {
  test("two ← presses close together in an empty editor make one double-tap", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000);
    expect(first.doubleTap).toBe(false);
    const second = press(first.gesture, KEYS.left, 1_200);
    expect(second.doubleTap).toBe(true);
    expect(second.gesture).toEqual(NO_ARROW_GESTURE);
  });

  test("a second ← later than the window is a new first press, not a double-tap", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000);
    const late = press(first.gesture, KEYS.left, 1_000 + DOUBLE_LEFT_MS + 1);
    expect(late.doubleTap).toBe(false);
    expect(late.gesture).toEqual({ pendingAt: 1_000 + DOUBLE_LEFT_MS + 1 });
  });

  test("the window includes exactly its last millisecond", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000);
    expect(press(first.gesture, KEYS.left, 1_000 + DOUBLE_LEFT_MS).doubleTap).toBe(true);
  });

  test("any other key between the two ← presses cancels the pending tap", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000);
    const between = press(first.gesture, KEYS.other, 1_100);
    expect(between.gesture).toEqual(NO_ARROW_GESTURE);
    expect(press(between.gesture, KEYS.left, 1_200).doubleTap).toBe(false);
  });

  test("a ← press in an editor that holds text never starts or completes a double-tap", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000, { emptyEditor: false });
    expect(first.gesture).toEqual(NO_ARROW_GESTURE);
    const second = press(first.gesture, KEYS.left, 1_100, { emptyEditor: false });
    expect(second.doubleTap).toBe(false);
  });

  test("a held key's repeats neither count as a tap nor cancel a pending one", () => {
    const first = press(NO_ARROW_GESTURE, KEYS.left, 1_000);
    const repeat = press(first.gesture, KEYS.left, 1_050, { repeat: true });
    expect(repeat).toEqual({ gesture: first.gesture, doubleTap: false });
    expect(press(repeat.gesture, KEYS.left, 1_100).doubleTap).toBe(true);
  });
});
