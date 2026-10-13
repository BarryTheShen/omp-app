import type { CompleteAttachment } from "@assistant-ui/react";
import { describe, expect, test } from "vitest";
import { withPastedText } from "./attachments";
import { lineCount, splitPastedBlocks, wrapPastedBlock } from "./pasted-block";

const SEPARATOR = "\n\n";

/** A segment by its content: the text, or a pasted block with its number and lines. */
type Plain =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "pasted";
      readonly text: string;
      readonly sequence: number;
      readonly lines: number;
    };

/** The segments by content alone: where each starts is pinned by its own test below. */
function split(message: string): Plain[] {
  return splitPastedBlocks(message).map(({ start: _start, ...segment }) => segment);
}

function pastedChip(name: string, text: string): CompleteAttachment {
  return {
    id: name,
    type: "file",
    name,
    contentType: "text/plain",
    status: { type: "complete" },
    content: [
      {
        type: "file",
        filename: name,
        mimeType: "text/plain",
        data: `data:text/plain;base64,${btoa(text)}`,
      },
    ],
  } as unknown as CompleteAttachment;
}

function pasted(text: string, sequence: number): Plain {
  return { kind: "pasted", text, sequence, lines: lineCount(text) };
}

function typed(text: string): Plain {
  return { kind: "text", text };
}

describe("the wrapper a pasted text is written in", () => {
  test("puts each tag on a line of its own, around the text, as omp does", () => {
    expect(wrapPastedBlock("a\nb")).toBe("<attachment>\na\nb\n</attachment>");
    expect(wrapPastedBlock("")).toBe("<attachment>\n\n</attachment>");
  });

  test("counts lines as the composer's chip name does", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\r\nb")).toBe(2);
    expect(lineCount("a\n")).toBe(2);
  });
});

describe("splitPastedBlocks: which parts of a message show as chips", () => {
  test("a message without a block is one text segment, unchanged", () => {
    expect(split("hello\nworld")).toEqual([typed("hello\nworld")]);
    expect(split("")).toEqual([typed("")]);
  });

  test("the typed text stays text, and the block after it is a chip", () => {
    expect(split(`Summarize this${SEPARATOR}${wrapPastedBlock("line one\nline two")}`)).toEqual([
      typed("Summarize this"),
      pasted("line one\nline two", 1),
    ]);
  });

  test("a message that is only a block is one chip", () => {
    expect(split(wrapPastedBlock("x"))).toEqual([pasted("x", 1)]);
  });

  test("blocks are numbered in order, with the typed text between them", () => {
    const message = `${wrapPastedBlock("A")}${SEPARATOR}between${SEPARATOR}${wrapPastedBlock("B\nC")}`;
    expect(split(message)).toEqual([pasted("A", 1), typed("between"), pasted("B\nC", 2)]);
  });

  test("text after the last block is kept", () => {
    expect(split(`${wrapPastedBlock("A")}${SEPARATOR}after`)).toEqual([
      pasted("A", 1),
      typed("after"),
    ]);
  });

  test("the separator is not typed text, but the typed text's own line breaks are", () => {
    const [first] = split(`typed\n\n${SEPARATOR}${wrapPastedBlock("A")}`);
    expect(first).toEqual(typed("typed\n\n"));
  });

  test("an empty block is a chip with no lines", () => {
    expect(split(wrapPastedBlock(""))).toEqual([pasted("", 1)]);
  });

  test("the block keeps its own line breaks, and CRLF counts as the composer counts it", () => {
    const text = "a\r\n\r\nb\n";
    expect(split(wrapPastedBlock(text))).toEqual([pasted(text, 1)]);
    expect(lineCount(text)).toBe(4);
  });

  test("each segment starts where its text begins in the message", () => {
    const message = `Hi${SEPARATOR}${wrapPastedBlock("A")}${SEPARATOR}after`;
    expect(splitPastedBlocks(message).map((segment) => segment.start)).toEqual([0, 4, 34]);
  });

  test("an unclosed opening tag stays plain text", () => {
    const message = "Look <attachment>\nno end";
    expect(split(message)).toEqual([typed(message)]);
  });

  test("a stray closing tag stays plain text", () => {
    const message = "done</attachment>";
    expect(split(message)).toEqual([typed(message)]);
  });

  test("an unclosed tag before a real block stays text, and the block is still a chip", () => {
    const message = `<attachment>\nstray${SEPARATOR}${wrapPastedBlock("PASTED")}`;
    expect(split(message)).toEqual([typed("<attachment>\nstray"), pasted("PASTED", 1)]);
  });

  test("a block whose text holds a wrapper tag stays plain text", () => {
    const message = wrapPastedBlock("<attachment>\nin\n</attachment>");
    expect(split(message)).toEqual([typed(message)]);
  });

  test("a block whose text holds only a closing tag stays plain text", () => {
    const message = wrapPastedBlock("a</attachment>b");
    expect(split(message)).toEqual([typed(message)]);
  });

  test("a block nested in another wrapper stays plain text, with the wrapper around it", () => {
    const message = `<attachment>\nouter${SEPARATOR}<attachment>\ninner\n</attachment>${SEPARATOR}after\n</attachment>`;
    expect(split(message)).toEqual([typed(message)]);
  });

  test("a block that does not start on its own, after the separator, stays plain text", () => {
    const inline = "see <attachment>\nx\n</attachment>";
    expect(split(inline)).toEqual([typed(inline)]);
    const glued = "typed<attachment>\nx\n</attachment>";
    expect(split(glued)).toEqual([typed(glued)]);
  });

  test("a block with text on its opening line stays plain text", () => {
    const message = "<attachment> \nx\n</attachment>";
    expect(split(message)).toEqual([typed(message)]);
  });

  test("a block followed by text with no separator stays plain text", () => {
    const message = `${wrapPastedBlock("x")}tail`;
    expect(split(message)).toEqual([typed(message)]);
  });

  test("adjacent blocks with no separator between them stay plain text", () => {
    const message = `${wrapPastedBlock("a")}${wrapPastedBlock("b")}`;
    expect(split(message)).toEqual([typed(message)]);
  });
});

describe("the writer and the splitter agree", () => {
  test("what the composer writes splits back into its typed text and each pasted text", () => {
    const message = withPastedText("Summarize", [
      pastedChip("Pasted text 1 (2 lines).txt", "first\nsecond"),
      pastedChip("Pasted text 2 (1 lines).txt", "third"),
    ]);
    expect(split(message)).toEqual([
      typed("Summarize"),
      pasted("first\nsecond", 1),
      pasted("third", 2),
    ]);
  });

  test("a message with no typed text is only its blocks", () => {
    const message = withPastedText("", [pastedChip("Pasted text 1 (1 lines).txt", "only")]);
    expect(split(message)).toEqual([pasted("only", 1)]);
  });
});
