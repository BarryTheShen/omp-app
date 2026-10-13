import { describe, expect, test } from "vitest";
import { placeNotices, type ThreadNotice } from "../../thread/notice-placement";

const rows = ["a", "b", "c", "d"];

describe("placeNotices", () => {
  test("a notice is drawn after the row it follows", () => {
    const placement = placeNotices(
      [{ key: "todo", afterRow: "b" }],
      rows,
      new Set(["a", "b", "c", "d"]),
    );
    expect(placement.after.get("b")).toEqual(["todo"]);
    expect(placement.top).toEqual([]);
    expect(placement.end).toEqual([]);
  });

  test("a row that is not drawn falls back to the nearest drawn row before it", () => {
    // `c` is a tool result joined into the answer `a` starts: the chat draws `a` and `d`, not `c`.
    const placement = placeNotices([{ key: "todo", afterRow: "c" }], rows, new Set(["a", "d"]));
    expect(placement.after.get("a")).toEqual(["todo"]);
    expect(placement.after.has("c")).toBe(false);
  });

  test("a notice with no drawn row before it goes to the top", () => {
    const placement = placeNotices([{ key: "todo", afterRow: "b" }], rows, new Set(["c"]));
    expect(placement.top).toEqual(["todo"]);
    expect(placement.after.size).toBe(0);
  });

  test("null goes to the top, and undefined or a row the transcript does not hold goes to the end", () => {
    const placement = placeNotices(
      [
        { key: "first", afterRow: null },
        { key: "retry", afterRow: undefined },
        { key: "gone", afterRow: "zz" },
      ],
      rows,
      new Set(rows),
    );
    expect(placement.top).toEqual(["first"]);
    expect(placement.end).toEqual(["retry", "gone"]);
  });

  test("notices after the same row keep the order they came in", () => {
    const notices: readonly ThreadNotice[] = [
      { key: "older", afterRow: "b" },
      { key: "newer", afterRow: "b" },
    ];
    const placement = placeNotices(notices, rows, new Set(rows));
    expect(placement.after.get("b")).toEqual(["older", "newer"]);
  });
});
