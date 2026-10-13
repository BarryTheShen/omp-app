import { describe, expect, test } from "vitest";
import { kindOfTypedText, removePromptToken, TypingHistory } from "./prompt-actions";

/** Types `text` one key at a time, as the composer reports each key before the text changes. */
function typeKeys(history: TypingHistory, text: string): string {
  let current = "";
  for (const character of text) {
    history.observeEdit(current, kindOfTypedText(character));
    current += character;
  }
  return current;
}

describe("removePromptToken (issue 1335)", () => {
  test("removes the token at the caret and leaves the caret where it was", () => {
    expect(removePromptToken("hello #", { start: 6, end: 7 })).toEqual({
      text: "hello ",
      cursor: 6,
    });
    expect(removePromptToken("hello#", { start: 5, end: 6 })).toEqual({ text: "hello", cursor: 5 });
    expect(removePromptToken("#", { start: 0, end: 1 })).toEqual({ text: "", cursor: 0 });
  });

  test("takes one space after the token with it, and keeps the rest of the text", () => {
    expect(removePromptToken("one #copy two", { start: 4, end: 9 })).toEqual({
      text: "one two",
      cursor: 4,
    });
    expect(removePromptToken("one #copy  two", { start: 4, end: 9 })).toEqual({
      text: "one  two",
      cursor: 4,
    });
  });
});

describe("TypingHistory (issue 1335)", () => {
  test("Undo reverts the last typed word, then the word before it", () => {
    const history = new TypingHistory();
    expect(typeKeys(history, "hello world")).toBe("hello world");
    expect(history.undo("hello world")).toBe("hello ");
    expect(history.undo("hello ")).toBe("");
    expect(history.undo("")).toBeUndefined();
  });

  test("a word takes the spaces typed after it, so Undo reverts both together", () => {
    const history = new TypingHistory();
    typeKeys(history, "one two  ");
    expect(history.undo("one two  ")).toBe("one ");
  });

  test("deleting is a step of its own: Undo restores what the deletion removed", () => {
    const history = new TypingHistory();
    typeKeys(history, "abc");
    history.observeEdit("abc", "delete");
    history.observeEdit("ab", "delete");
    history.observeEdit("a", "delete");
    expect(history.undo("")).toBe("abc");
  });

  test("an edit that is not one typed character is not typing: a paste is not undone", () => {
    const history = new TypingHistory();
    history.observeEdit("", kindOfTypedText("pasted text"));
    expect(history.undo("pasted text")).toBeUndefined();
  });

  test("the # token being typed is not an edit, so Undo after a # action reverts the last real edit", () => {
    const history = new TypingHistory();
    typeKeys(history, "hello #undo");
    // The # action removed the token: the text left is "hello ", the word typed before it.
    expect(history.undo("hello ")).toBe("");
  });

  test("a keystroke inside an open # token is not recorded", () => {
    const history = new TypingHistory();
    history.observeEdit("hello #", "space");
    expect(history.undo("hello ")).toBeUndefined();
  });

  test("a step that would restore the text already there is skipped", () => {
    const history = new TypingHistory();
    typeKeys(history, "ab");
    // Nothing to restore to but the text itself: the step is skipped.
    expect(history.undo("")).toBeUndefined();
  });
});
