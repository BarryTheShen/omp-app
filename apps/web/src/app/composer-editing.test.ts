import { describe, expect, test } from "vitest";
import { accumulateKill, deleteToLineStartRange } from "./composer-editing";

describe("Ctrl+U: delete to the start of the line", () => {
  test("removes the text from the line start up to the caret", () => {
    expect(deleteToLineStartRange("hello world", 6)).toEqual({
      start: 0,
      end: 6,
      deleted: "hello ",
    });
  });

  test("on a later line, stops at that line's start and leaves the lines above alone", () => {
    expect(deleteToLineStartRange("one\ntwo", 6)).toEqual({ start: 4, end: 6, deleted: "tw" });
  });

  test("at the start of a line, removes the line break before the caret, joining the line above", () => {
    expect(deleteToLineStartRange("one\ntwo", 4)).toEqual({ start: 3, end: 4, deleted: "\n" });
  });

  test("at the very start of the text there is nothing to remove", () => {
    expect(deleteToLineStartRange("abc", 0)).toBeNull();
  });
});

describe("the kill ring", () => {
  test("a delete made right after a delete adds up, in front of what is there", () => {
    expect(accumulateKill("world", "hello ", true)).toBe("hello world");
  });

  test("a delete after other editing starts a new entry", () => {
    expect(accumulateKill("world", "hello ", false)).toBe("hello ");
  });
});
