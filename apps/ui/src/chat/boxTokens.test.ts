import { describe, expect, test } from "vitest";
import { keepWhole, snapSelection, tokensIn } from "./boxTokens";

const MARKER = "[Image #1, 2313x105]";
const SECRET = "$$APIKEY_2XUBD7NWOZ1U:L$$";

/** The box after an edit: `before` with `from`..`to` replaced by `typed`, the caret after what was typed. */
function edit(before: string, from: number, to: number, typed: string, known: string[] = []) {
  const after = before.slice(0, from) + typed + before.slice(to);
  const caret = from + typed.length;
  return keepWhole(before, after, caret, tokensIn(before, known)) ?? { text: after, caret };
}

describe("references in the box", () => {
  test("a picture's marker, a secret's placeholder and the box's own mentions are found whole", () => {
    const text = `see ${MARKER} with ${SECRET} and @Birthday menu, not @Birthday menus`;
    const found = tokensIn(text, ["@Birthday menu"]).map((token) =>
      text.slice(token.start, token.end),
    );
    expect(found).toEqual([MARKER, SECRET, "@Birthday menu"]);
  });

  test("Backspace at a reference's end takes it whole", () => {
    const before = `look ${MARKER} here`;
    const end = before.indexOf("]") + 1;
    expect(edit(before, end - 1, end, "")).toEqual({ text: "look  here", caret: 5 });
  });

  test("Delete at a reference's start takes it whole", () => {
    const before = `look ${MARKER}`;
    expect(edit(before, 5, 6, "")).toEqual({ text: "look ", caret: 5 });
  });

  test("a word deleted across part of one, or a selection typed over half of one, takes it whole", () => {
    const before = `a ${MARKER} b`;
    const half = before.indexOf("2313");
    expect(edit(before, half, before.length - 2, "")).toEqual({ text: "a  b", caret: 2 });
    expect(edit(before, half, before.length, "c")).toEqual({ text: "a c", caret: 3 });
  });

  test("a mention's label goes whole: half of it is never left as text", () => {
    const before = "plan @Birthday menu now";
    const end = before.indexOf(" now");
    expect(edit(before, end - 1, end, "", ["@Birthday menu"])).toEqual({
      text: "plan  now",
      caret: 5,
    });
    expect(edit(before, 9, 11, "", ["@Birthday menu"])).toEqual({ text: "plan  now", caret: 5 });
  });

  test("a secret's placeholder goes whole", () => {
    const before = `key ${SECRET}`;
    expect(edit(before, before.length - 1, before.length, "")).toEqual({ text: "key ", caret: 4 });
  });

  test("text typed inside a reference goes after it", () => {
    const before = `a ${MARKER} b`;
    const inside = before.indexOf("2313");
    const end = 2 + MARKER.length;
    expect(edit(before, inside, inside, "x")).toEqual({
      text: `a ${MARKER}x b`,
      caret: end + 1,
    });
  });

  test("edits beside a reference, or that take it whole, are left as they are", () => {
    const before = `ab ${MARKER} cd`;
    expect(keepWhole(before, `a ${MARKER} cd`, 1, tokensIn(before, []))).toBeNull();
    expect(keepWhole(before, `ab ${MARKER} c`, before.length - 1, tokensIn(before, []))).toBeNull();
    expect(keepWhole(before, "ab  cd", 3, tokensIn(before, []))).toBeNull();
    expect(keepWhole("plain text", "plan text", 3, tokensIn("plain text", []))).toBeNull();
  });

  test("the caret steps over a reference: to its far edge as it moves, to the nearer edge on a tap", () => {
    const text = `a ${MARKER} b`;
    const tokens = tokensIn(text, []);
    const start = 2;
    const end = 2 + MARKER.length;
    // An arrow from the left lands inside: it goes on to the end; from the right, to the start.
    expect(snapSelection(start + 1, start + 1, tokens, start)).toEqual({ start: end, end });
    expect(snapSelection(end - 1, end - 1, tokens, end)).toEqual({ start, end: start });
    // A tap: the nearer edge.
    expect(snapSelection(start + 2, start + 2, tokens, null)).toEqual({ start, end: start });
    expect(snapSelection(end - 2, end - 2, tokens, null)).toEqual({ start: end, end });
    // A caret beside it stays.
    expect(snapSelection(end, end, tokens, null)).toEqual({ start: end, end });
  });

  test("a selection that cuts a reference takes it whole", () => {
    const text = `a ${MARKER} b`;
    const tokens = tokensIn(text, []);
    expect(snapSelection(0, 6, tokens, null)).toEqual({ start: 0, end: 2 + MARKER.length });
    expect(snapSelection(6, text.length, tokens, null)).toEqual({ start: 2, end: text.length });
  });
});
