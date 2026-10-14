import { describe, expect, test } from "bun:test";
import { firstPromptTextOf, wrapPastedBlock } from "../src/core/pasted-block";

const SEPARATOR = "\n\n";

describe("firstPromptTextOf: the words a chat lists as its first prompt", () => {
  test("a message with a block in exact form lists its typed text alone", () => {
    expect(
      firstPromptTextOf(`Summarize this${SEPARATOR}${wrapPastedBlock("line one\nline two")}`),
    ).toBe("Summarize this");
  });

  test("text on both sides of a block is joined by a space", () => {
    expect(firstPromptTextOf(`A${SEPARATOR}${wrapPastedBlock("B")}${SEPARATOR}C`)).toBe("A C");
  });

  test("a message that is only a pasted block lists the first line of its text", () => {
    expect(firstPromptTextOf(wrapPastedBlock("only pasted\nsecond line"))).toBe("only pasted");
  });

  test("the line listed is trimmed, and it is the first line with words", () => {
    expect(firstPromptTextOf(wrapPastedBlock("\n   \n   spaced out  \nnext"))).toBe("spaced out");
  });

  test("the first pasted text with words is listed when a blank one comes before it", () => {
    const message = `${wrapPastedBlock("  \n")}${SEPARATOR}${wrapPastedBlock("second text")}`;
    expect(firstPromptTextOf(message)).toBe("second text");
  });

  test("a message whose pasted text has no words lists nothing", () => {
    expect(firstPromptTextOf(wrapPastedBlock("  \n  "))).toBe("");
  });

  test("a line ending in a carriage return ends at the words", () => {
    expect(firstPromptTextOf(wrapPastedBlock("first\r\nsecond"))).toBe("first");
  });

  test("a wrapper that is not in exact form is typed text, as the transcript shows it", () => {
    const typed = "Look at <attachment>x</attachment> here";
    expect(firstPromptTextOf(typed)).toBe(typed);
  });

  test("a message with no block is its own text", () => {
    expect(firstPromptTextOf("plain words")).toBe("plain words");
  });
});
