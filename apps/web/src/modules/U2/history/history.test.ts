import { describe, expect, test } from "vitest";
import { PromptHistoryController } from "./history";

describe("U2.5 prompt history", () => {
  test("walks previous prompts and restores the draft at the end", () => {
    const controller = new PromptHistoryController({
      getUserPrompts: () => ["first", "second"],
      subscribe: () => () => undefined,
    });
    let text = "current draft";
    let selection = [0, text.length];
    const setText = (next: string) => {
      text = next;
    };
    const setSelection = (start: number, end: number) => {
      selection = [start, end];
    };
    expect(
      controller.handleKeyDown(
        {
          key: "ArrowUp",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          preventDefault() {},
        },
        text,
        0,
        0,
        setText,
        setSelection,
      ),
    ).toBe(true);
    expect(text).toBe("second");
    expect(selection).toEqual([0, 0]);
    controller.handleKeyDown(
      {
        key: "ArrowDown",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault() {},
      },
      text,
      text.length,
      text.length,
      setText,
      setSelection,
    );
    expect(text).toBe("current draft");
    expect(selection).toEqual([13, 13]);
  });

  test("searches source prompts without creating durable state", () => {
    const controller = new PromptHistoryController({
      getUserPrompts: () => ["fix tests", "write docs", "fix types"],
      subscribe: () => () => undefined,
    });
    expect(controller.search("fix")).toEqual(["fix types", "fix tests"]);
    expect(controller.search("")).toEqual(["fix types", "write docs", "fix tests"]);
  });
});
