import { describe, expect, test } from "bun:test";
import {
  attachedSummary,
  firstPromptTextOf,
  localUrl,
  splitAttached,
  withAttached,
} from "../src/index";

const FILES = [
  { name: "lecture 3 notes.pdf", size: "2.4 MB" },
  { name: "résumé (final).docx", size: "88.0 KB" },
  { name: "50% off?#1`a`\\b.txt", size: "12 B" },
];

describe("the paragraph naming a message's attached files", () => {
  test("a name is written as omp decodes it: a space as it is, %, ?, #, \\ and ` escaped", () => {
    expect(localUrl("lecture 3 notes.pdf")).toBe("local://lecture 3 notes.pdf");
    expect(localUrl("50% off?#1`a`\\b.txt")).toBe("local://50%25 off%3F%231%60a%60%5Cb.txt");
  });

  test("the text and the files read back as they were sent, whatever the names hold", () => {
    const message = withAttached("Put these in my course folder.", FILES);
    expect(message.startsWith("Put these in my course folder.\n\n")).toBe(true);
    expect(splitAttached(message)).toEqual({
      text: "Put these in my course folder.",
      files: FILES,
    });
  });

  test("files sent without text read back with an empty text", () => {
    expect(splitAttached(withAttached("", FILES.slice(0, 1)))).toEqual({
      text: "",
      files: FILES.slice(0, 1),
    });
  });

  test("empty parts joined after the paragraph (a picture's place) still read back as files", () => {
    const message = `${withAttached("Look at these", FILES.slice(0, 1))}\n\n`;
    expect(splitAttached(message)).toEqual({ text: "Look at these", files: FILES.slice(0, 1) });
    expect(firstPromptTextOf(message)).toBe("Look at these");
  });

  test("a message that only looks like it is all text", () => {
    const paragraph = withAttached("", FILES.slice(0, 1));
    for (const message of [
      `See this:\n${paragraph}`,
      `${paragraph}\nand some words after it`,
      `${paragraph.split("\n")[0]}\n- local://no-backticks.pdf (1 KB)`,
      paragraph.split("\n")[0] ?? "",
    ]) {
      expect(splitAttached(message)).toEqual({ text: message, files: [] });
    }
  });

  test("a queued message is listed by its text and its files' names", () => {
    expect(attachedSummary(withAttached("Read this", FILES.slice(0, 2)))).toBe(
      "Read this (+ lecture 3 notes.pdf, résumé (final).docx)",
    );
    expect(attachedSummary(withAttached("", FILES.slice(0, 1)))).toBe("lecture 3 notes.pdf");
    expect(attachedSummary("plain words")).toBe("plain words");
  });

  test("a chat's first prompt is what was typed, or its files' names when only files were sent", () => {
    expect(firstPromptTextOf(withAttached("Read this", FILES.slice(0, 1)))).toBe("Read this");
    expect(firstPromptTextOf(withAttached("", FILES.slice(0, 2)))).toBe(
      "lecture 3 notes.pdf, résumé (final).docx",
    );
  });
});
