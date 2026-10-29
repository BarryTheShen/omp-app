import { describe, expect, test } from "vitest";
import {
  addTab,
  closeTab,
  initialTabs,
  loadTabs,
  moveTab,
  renameTab,
  stepTab,
  type WorkspaceTabs,
} from "./tabs";

const ids = (state: WorkspaceTabs): string[] => state.tabs.map((tab) => tab.id);
const three = (): WorkspaceTabs => ({
  tabs: ["a", "b", "c"].map((id) => ({ id, title: null, layout: null })),
  active: "b",
});

describe("workspace tabs", () => {
  test("a new tab goes right after the active one and becomes active", () => {
    const next = addTab(three());
    expect(ids(next)).toHaveLength(4);
    expect(ids(next).slice(0, 2)).toEqual(["a", "b"]);
    expect(next.active).toBe(ids(next)[2]);
  });

  test("closing the active tab activates its right neighbour, or its left one at the end", () => {
    expect(closeTab(three(), "b")).toMatchObject({ active: "c" });
    expect(closeTab({ ...three(), active: "c" }, "c")).toMatchObject({ active: "b" });
    expect(ids(closeTab(three(), "a"))).toEqual(["b", "c"]);
    expect(closeTab(three(), "a").active).toBe("b");
  });

  test("closing the last tab leaves one empty tab", () => {
    const only = initialTabs();
    const after = closeTab(only, only.active);
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.layout).toBeNull();
    expect(after.active).toBe(after.tabs[0]?.id);
  });

  test("next and previous wrap around; moving stops at the ends", () => {
    expect(stepTab({ ...three(), active: "c" }, 1).active).toBe("a");
    expect(stepTab({ ...three(), active: "a" }, -1).active).toBe("c");
    expect(ids(moveTab(three(), 1))).toEqual(["a", "c", "b"]);
    expect(ids(moveTab({ ...three(), active: "c" }, 1))).toEqual(["a", "b", "c"]);
    expect(ids(moveTab({ ...three(), active: "a" }, -1))).toEqual(["a", "b", "c"]);
  });

  test("a blank name goes back to the chat's title", () => {
    expect(renameTab(three(), "b", "  Parser  ").tabs[1]?.title).toBe("Parser");
    expect(renameTab(renameTab(three(), "b", "Parser"), "b", "  ").tabs[1]?.title).toBeNull();
  });

  test("kept tabs come back; anything unreadable starts with one empty tab", () => {
    const kept = JSON.stringify({ tabs: [{ id: "x", title: "Work", layout: null }], active: "x" });
    expect(loadTabs(kept)).toEqual({
      tabs: [{ id: "x", title: "Work", layout: null }],
      active: "x",
    });
    expect(
      loadTabs(JSON.stringify({ tabs: [{ id: "x", title: null, layout: null }], active: "gone" }))
        .active,
    ).toBe("x");
    for (const raw of [null, "", "{", "[]", JSON.stringify({ tabs: [{ title: 3 }] })])
      expect(loadTabs(raw).tabs).toHaveLength(1);
  });
});
