import { describe, expect, test } from "vitest";
import { threadFromMessage } from "./threads";

describe("a thread from the Workbench's message box", () => {
  test("a short one-line message is the title, with no text of its own", () => {
    expect(threadFromMessage("  When is the job app done?  ")).toEqual({
      title: "When is the job app done?",
      text: "",
    });
  });

  test("more lines: the first is the title, and the whole message is the text", () => {
    expect(threadFromMessage("Slow new chat\n\nIt takes 30 s to list.")).toEqual({
      title: "Slow new chat",
      text: "Slow new chat\n\nIt takes 30 s to list.",
    });
  });

  test("a long first line is cut at a word for the title, and kept whole in the text", () => {
    const long =
      "So when is everything done for the job app that I asked about yesterday, and what still waits on me";
    const thread = threadFromMessage(long);
    expect(thread?.title).toBe(
      "So when is everything done for the job app that I asked about yesterday, and…",
    );
    expect(thread?.title.length).toBeLessThanOrEqual(80);
    expect(thread?.text).toBe(long);
  });

  test("nothing but spaces opens nothing", () => {
    expect(threadFromMessage(" \n  ")).toBeNull();
  });
});
