import { describe, expect, test } from "vitest";
import { PromptHistoryController, type PromptHistoryKeyEvent } from "./history";

function arrow(
  key: "ArrowUp" | "ArrowDown",
  overrides: Partial<PromptHistoryKeyEvent> = {},
): PromptHistoryKeyEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    ...overrides,
  };
}

/** A composer the controller edits: `press` reads the text and caret as the DOM holds them. */
function editor(prompts: readonly string[], text = "") {
  const controller = new PromptHistoryController({
    getUserPrompts: () => prompts,
    subscribe: () => () => undefined,
  });
  const state = { text, start: text.length, end: text.length };
  const press = (key: "ArrowUp" | "ArrowDown", overrides?: Partial<PromptHistoryKeyEvent>) =>
    controller.handleKeyDown(
      arrow(key, overrides),
      state.text,
      state.start,
      state.end,
      (next) => {
        state.text = next;
      },
      (start, end) => {
        state.start = start;
        state.end = end;
      },
    );
  return { controller, state, press };
}

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

  test("Up again goes further back and stops at the oldest; Down walks forward to the draft", () => {
    const ed = editor(["first", "second", "third"], "draft");
    ed.state.start = 0;
    ed.state.end = 0;
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.state.text).toBe("third");
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.state.text).toBe("second");
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.state.text).toBe("first");
    expect(ed.controller.snapshot()).toMatchObject({ index: 2, draft: "draft" });
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.state.text).toBe("second");
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.state.text).toBe("draft");
    expect(ed.state.start).toBe(5);
    expect(ed.controller.snapshot()).toMatchObject({ index: -1, draft: null });
  });

  test("an empty history takes no arrow", () => {
    const ed = editor([], "");
    expect(ed.press("ArrowUp")).toBe(false);
    expect(ed.state.text).toBe("");
  });

  test("a caret inside multi-line text keeps Up and Down", () => {
    const ed = editor(["older", "first\nsecond"], "one\ntwo");
    ed.state.start = 5;
    ed.state.end = 5;
    expect(ed.press("ArrowUp")).toBe(false);
    expect(ed.press("ArrowDown")).toBe(false);
    expect(ed.state.text).toBe("one\ntwo");

    ed.state.text = "";
    ed.state.start = 0;
    ed.state.end = 0;
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.state.text).toBe("first\nsecond");
    // Browsing a multi-line prompt: Down on its first line is the caret's, Up on its last line too.
    expect(ed.press("ArrowDown")).toBe(false);
    ed.state.start = 6;
    ed.state.end = 6;
    expect(ed.press("ArrowUp")).toBe(false);
    expect(ed.state.text).toBe("first\nsecond");
    // On the last line, Down walks forward again.
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.state.text).toBe("");
  });

  test("a key another handler already took is left to it", () => {
    const ed = editor(["only"], "");
    expect(ed.press("ArrowUp", { defaultPrevented: true })).toBe(false);
    expect(ed.state.text).toBe("");
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.press("ArrowDown", { defaultPrevented: true })).toBe(false);
    expect(ed.state.text).toBe("only");
  });

  test("IME composition, modifier keys and a selection are left alone", () => {
    const ed = editor(["only"], "");
    expect(ed.press("ArrowUp", { nativeEvent: { isComposing: true } })).toBe(false);
    expect(ed.press("ArrowUp", { shiftKey: true })).toBe(false);
    expect(ed.press("ArrowUp", { altKey: true })).toBe(false);
    ed.state.start = 0;
    ed.state.end = 3;
    expect(ed.press("ArrowUp")).toBe(false);
    expect(ed.state.text).toBe("");
  });

  test("text the user types over a recalled prompt ends browsing", () => {
    const ed = editor(["second", "first"], "");
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.state.text).toBe("first");
    ed.state.text = "first, edited";
    ed.state.start = ed.state.end = ed.state.text.length;
    expect(ed.controller.isRecalled("first, edited")).toBe(false);
    expect(ed.press("ArrowDown")).toBe(false);
    expect(ed.state.text).toBe("first, edited");
  });

  test("a changed prompt list ends browsing; an unchanged one keeps it", () => {
    const ed = editor(["first", "second"], "");
    expect(ed.press("ArrowUp")).toBe(true);
    ed.controller.update(["first", "second"]);
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.state.text).toBe("");

    expect(ed.press("ArrowUp")).toBe(true);
    ed.controller.update(["first", "second", "third"]);
    expect(ed.press("ArrowDown")).toBe(false);
    expect(ed.state.text).toBe("second");
  });

  test("isRecalled is true only for the prompt Up or Down put in the composer", () => {
    const ed = editor(["second"], "typed");
    expect(ed.controller.isRecalled("second")).toBe(false);
    ed.state.start = 0;
    ed.state.end = 0;
    expect(ed.press("ArrowUp")).toBe(true);
    expect(ed.controller.isRecalled("second")).toBe(true);
    expect(ed.controller.isRecalled("typed")).toBe(false);
    ed.state.start = ed.state.end = ed.state.text.length;
    expect(ed.press("ArrowDown")).toBe(true);
    expect(ed.controller.isRecalled("typed")).toBe(false);
  });
});
