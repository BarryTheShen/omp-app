import { describe, expect, test } from "vitest";
import { searchPrompts } from "./history-search";

const prompts = ["first alpha note", "second beta note", "third gamma note"];
const texts = (hits: ReturnType<typeof searchPrompts>) => hits.map((hit) => hit.text);

describe("searchPrompts", () => {
  test("lists every message, newest first, when no words are typed", () => {
    expect(texts(searchPrompts(prompts, ""))).toEqual([
      "third gamma note",
      "second beta note",
      "first alpha note",
    ]);
  });

  test("keeps only the messages that contain every typed word, ignoring case and punctuation", () => {
    expect(texts(searchPrompts(prompts, "BETA, note"))).toEqual(["second beta note"]);
  });

  test("each hit keeps its place among the messages, so it can be told apart from a repeat", () => {
    expect(searchPrompts(["same", "other", "same"], "same")).toEqual([
      { index: 2, text: "same" },
      { index: 0, text: "same" },
    ]);
  });

  test("a word that appears in no message leaves nothing", () => {
    expect(searchPrompts(prompts, "delta")).toEqual([]);
  });

  test("with no messages at all, nothing matches", () => {
    expect(searchPrompts([], "anything")).toEqual([]);
  });
});
