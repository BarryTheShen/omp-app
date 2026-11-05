import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  addTab,
  closeTab,
  initialTabs,
  layoutStorage,
  loadTabs,
  moveTab,
  moveTabTo,
  nameAfterChat,
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

  test("a workspace dragged right lands after the one it was dropped on; dragged left, before it (#2791)", () => {
    expect(ids(moveTabTo(three(), "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveTabTo(three(), "c", 0))).toEqual(["c", "a", "b"]);
    expect(ids(moveTabTo(three(), "a", 1))).toEqual(["b", "a", "c"]);
    // Onto itself, past the end, or a workspace that is gone: nothing moves.
    for (const [id, to] of [
      ["b", 1],
      ["b", 3],
      ["gone", 0],
    ] as const)
      expect(moveTabTo(three(), id, to)).toEqual(three());
    expect(moveTabTo(three(), "a", 2).active).toBe("b");
  });

  test("a workspace takes its first chat's title, follows that chat as omp names it, and never another chat's (#2791, #2829)", () => {
    const named = nameAfterChat(three(), "a", "Fix the build", "pane-1");
    expect(named.tabs[0]).toMatchObject({ id: "a", title: null, firstTitle: "Fix the build" });
    // Another window's chat leaves it; its own chat's later name (omp's, after the first message) is taken.
    expect(nameAfterChat(named, "a", "Another chat", "pane-2")).toBe(named);
    const followed = nameAfterChat(named, "a", "Build fixes", "pane-1");
    expect(followed.tabs[0]).toMatchObject({ firstTitle: "Build fixes" });
    // A name given with Rename is shown over it; cleared, the first chat's title is back.
    const renamed = renameTab(followed, "a", "Mine");
    expect(renamed.tabs[0]).toMatchObject({ title: "Mine", firstTitle: "Build fixes" });
    expect(renameTab(renamed, "a", " ").tabs[0]).toMatchObject({
      title: null,
      firstTitle: "Build fixes",
    });
    // A workspace kept before it knew its window takes the one that names it now.
    const kept = {
      tabs: [{ id: "k", title: null, firstTitle: "First message", layout: null }],
      active: "k",
    };
    expect(nameAfterChat(kept, "k", "omp's name", "pane-9").tabs[0]).toMatchObject({
      firstTitle: "omp's name",
      firstPane: "pane-9",
    });
  });

  test("workspaces kept before they had a first chat's title come back as they were (#2791)", () => {
    const kept = JSON.stringify({ tabs: [{ id: "x", title: null, layout: null }], active: "x" });
    expect(loadTabs(kept).tabs).toEqual([{ id: "x", title: null, layout: null }]);
    const named = JSON.stringify({
      tabs: [{ id: "x", title: null, firstTitle: "Fix the build", layout: null }],
      active: "x",
    });
    expect(loadTabs(named).tabs[0]).toMatchObject({ firstTitle: "Fix the build" });
    const broken = JSON.stringify({
      tabs: [{ id: "x", title: null, firstTitle: 3, layout: null }],
    });
    expect(loadTabs(broken).tabs[0]?.id).not.toBe("x");
  });
});

describe("where a page keeps its tabs", () => {
  // The unit tests run without a DOM: each storage is a marker the choice returns.
  beforeAll(() => {
    vi.stubGlobal("localStorage", "the first window's storage");
    vi.stubGlobal("sessionStorage", "the window's own storage");
  });
  afterAll(() => vi.unstubAllGlobals());

  test("the first desktop window keeps them for the next start; another desktop window keeps its own", () => {
    expect(layoutStorage(true, "")).toBe("the first window's storage");
    expect(layoutStorage(true, "?window=main")).toBe("the first window's storage");
    expect(layoutStorage(true, "?window=")).toBe("the first window's storage");
    expect(layoutStorage(true, "?window=window-2")).toBe("the window's own storage");
    expect(layoutStorage(true, "?folder=%2Ftmp&window=window-12")).toBe("the window's own storage");
  });

  test("a browser tab keeps them for the next start whatever its address says", () => {
    expect(layoutStorage(false, "")).toBe("the first window's storage");
    expect(layoutStorage(false, "?window=window-2")).toBe("the first window's storage");
  });
});
