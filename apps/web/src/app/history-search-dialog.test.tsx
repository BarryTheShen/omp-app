import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HistorySearchDialog } from "./history-search-dialog";

// jsdom has no layout and no scrollIntoView, so the test records which row the dialog asks to scroll into view.
interface Scroll {
  readonly row: Element;
  readonly options: unknown;
}
let scrolls: Scroll[] = [];
const prototype = Element.prototype as Partial<Pick<Element, "scrollIntoView">>;

beforeEach(() => {
  scrolls = [];
  prototype.scrollIntoView = function scrollIntoView(this: Element, options?: unknown) {
    scrolls.push({ row: this, options });
  };
});

afterEach(() => {
  cleanup();
  delete prototype.scrollIntoView;
  vi.restoreAllMocks();
});

// Newest first, so row 0 is "message 30" and row 12 is "message 18".
const prompts = Array.from({ length: 30 }, (_, index) => `message ${index + 1}`);

function renderDialog(onPick = vi.fn()) {
  render(
    <HistorySearchDialog
      open
      onOpenChange={() => {}}
      readPrompts={() => prompts}
      onPick={onPick}
    />,
  );
  return screen.getByRole("searchbox", { name: "Type words to search" });
}

function lastScroll(): Scroll {
  const scroll = scrolls.at(-1);
  if (scroll === undefined) throw new Error("The dialog scrolled no row into view.");
  return scroll;
}

describe("history search dialog", () => {
  test("Down scrolls the highlighted row into view, so Enter picks a row the person can see", () => {
    const onPick = vi.fn();
    const search = renderDialog(onPick);
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(search, { key: "ArrowDown" });

    const highlighted = screen.getByRole("option", { selected: true });
    expect(highlighted.textContent).toBe("message 18");
    expect(lastScroll().row).toBe(highlighted);
    expect(lastScroll().options).toEqual({ block: "nearest" });

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("message 18");
  });
  test("an IME Enter with keyCode 229 does not pick the highlighted history row", () => {
    const onPick = vi.fn();
    const search = renderDialog(onPick);

    fireEvent.keyDown(search, { key: "Enter", keyCode: 229, isComposing: false });

    expect(onPick).not.toHaveBeenCalled();
  });

  test("Up scrolls the highlighted row back into view, up to the top row", () => {
    const search = renderDialog();
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(search, { key: "ArrowDown" });
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(search, { key: "ArrowUp" });

    const highlighted = screen.getByRole("option", { selected: true });
    expect(highlighted.textContent).toBe("message 30");
    expect(lastScroll().row).toBe(highlighted);
  });

  test("a new search starts at the top of the list, so the row Enter picks is in view", () => {
    const search = renderDialog();
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(search, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    // The person has scrolled the list down with the mouse wheel.
    list.scrollTop = 400;
    expect(list.scrollTop).toBe(400);

    fireEvent.change(search, { target: { value: "message" } });

    expect(list.scrollTop).toBe(0);
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("message 30");
  });
});
