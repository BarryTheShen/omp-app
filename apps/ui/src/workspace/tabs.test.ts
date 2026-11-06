import type { SerializedDockview } from "dockview-react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  blankTab,
  closeTab,
  goToTab,
  initialTabs,
  insertTab,
  layoutStorage,
  loadTabs,
  MAX_CLOSED,
  moveTab,
  moveTabTo,
  nameAfterChat,
  renameTab,
  reopenTab,
  stepTab,
  type WorkspaceTab,
  type WorkspaceTabs,
} from "./tabs";

const ids = (state: WorkspaceTabs): string[] => state.tabs.map((tab) => tab.id);
const three = (): WorkspaceTabs => ({
  tabs: ["a", "b", "c"].map((id) => ({ id, title: null, layout: null })),
  active: "b",
});

describe("workspace tabs", () => {
  test("a new tab goes right after the active one and becomes active", () => {
    const tab = blankTab();
    const next = insertTab(three(), tab, "b", true);
    expect(ids(next)).toEqual(["a", "b", tab.id, "c"]);
    expect(next.active).toBe(tab.id);
  });

  test("closing the active tab activates its right neighbour, or its left one at the end", () => {
    expect(closeTab(three(), "b")).toMatchObject({ active: "c" });
    expect(closeTab({ ...three(), active: "c" }, "c")).toMatchObject({ active: "b" });
    expect(ids(closeTab(three(), "a"))).toEqual(["b", "c"]);
    expect(closeTab(three(), "a").active).toBe("b");
  });

  test("closing a tab goes back to the one it was opened from while that one is there (#2831)", () => {
    expect(closeTab(three(), "b", "a").active).toBe("a");
    // The owner is gone: the right neighbour, as without one.
    expect(closeTab(three(), "b", "gone").active).toBe("c");
    // A tab closed behind the active one changes nothing.
    expect(closeTab(three(), "c", "a").active).toBe("b");
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

  /** A workspace with one chat's window, as dockview saves it. */
  const held = (id: string, title: string | null = null): WorkspaceTab => ({
    id,
    title,
    layout: { panels: { [`pane-${id}`]: { id: `pane-${id}` } } } as unknown as SerializedDockview,
  });

  test("a closed workspace comes back at its place with its windows and name; the last closed first (#2831)", () => {
    const state: WorkspaceTabs = { tabs: [held("a"), held("b", "Course"), held("c")], active: "b" };
    const closed = closeTab(closeTab(state, "b"), "a");
    expect(ids(closed)).toEqual(["c"]);
    const once = reopenTab(closed);
    expect(ids(once)).toEqual(["a", "c"]);
    expect(once.active).toBe("a");
    const twice = reopenTab(once);
    expect(ids(twice)).toEqual(["a", "b", "c"]);
    expect(twice.tabs[1]).toEqual(held("b", "Course"));
    expect(twice.active).toBe("b");
    // Nothing left to reopen.
    expect(reopenTab(twice)).toBe(twice);
  });

  test("a blank workspace closed is not kept, and only the last ten closed are (#2831)", () => {
    expect(closeTab(three(), "b").closed).toBeUndefined();
    let state: WorkspaceTabs = {
      tabs: Array.from({ length: 12 }, (_, n) => held(`t${n}`)).concat({
        id: "keep",
        title: null,
        layout: null,
      }),
      active: "keep",
    };
    for (let n = 0; n < 12; n += 1) state = closeTab(state, `t${n}`);
    expect(state.closed?.map((entry) => entry.tab.id)).toEqual(
      Array.from({ length: MAX_CLOSED }, (_, n) => `t${n + 2}`),
    );
  });

  test("a renamed or split workspace is kept when closed though it holds no chat; one blank window is not (#2831)", () => {
    const grid = (windows: number) =>
      ({
        grid: {
          root: {
            type: "branch",
            data: Array.from({ length: windows }, () => ({ type: "leaf", data: {} })),
          },
        },
        panels: {},
      }) as unknown as SerializedDockview;
    const keep = { id: "keep", title: null, layout: null };
    const kept = (tab: WorkspaceTab) =>
      closeTab({ tabs: [tab, keep], active: tab.id }, tab.id).closed?.map((entry) => entry.tab.id);
    expect(kept({ id: "named", title: "Plans", layout: null })).toEqual(["named"]);
    expect(kept({ id: "split", title: null, layout: grid(2) })).toEqual(["split"]);
    expect(kept({ id: "one", title: null, layout: grid(1) })).toBeUndefined();
    // A layout this version cannot read counts as one window.
    expect(
      kept({ id: "odd", title: null, layout: { panels: {} } as unknown as SerializedDockview }),
    ).toBeUndefined();
    // Reopened while only a renamed workspace is left, it goes beside it rather than in its place.
    const named = { id: "named", title: "Plans", layout: null };
    const state = closeTab({ tabs: [held("a"), named], active: "a" }, "a");
    expect(ids(reopenTab(state))).toEqual(["a", "named"]);
  });

  test("the last workspace closed comes back in place of the blank one its closing left (#2831)", () => {
    const only: WorkspaceTabs = { tabs: [held("a")], active: "a" };
    const after = closeTab(only, "a");
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.id).not.toBe("a");
    expect(reopenTab(after)).toEqual({ tabs: [held("a")], active: "a" });
  });

  test("closed workspaces are kept with the tabs; a kept one that is open again or unreadable is dropped (#2831)", () => {
    const state = closeTab({ tabs: [held("a"), held("b")], active: "a" }, "b");
    expect(loadTabs(JSON.stringify(state))).toEqual(state);
    const odd = JSON.stringify({
      ...state,
      closed: [
        { tab: held("a"), index: 0 },
        { tab: { id: 3 }, index: 0 },
        { tab: held("z"), index: -1 },
      ],
    });
    expect(loadTabs(odd).closed).toBeUndefined();
  });

  test("a workspace opened behind goes after the one given and leaves the active one in front (#2831)", () => {
    const tab = { id: "x", title: null, layout: null };
    const behind = insertTab(three(), tab, "b", false);
    expect(ids(behind)).toEqual(["a", "b", "x", "c"]);
    expect(behind.active).toBe("b");
    const chained = insertTab(behind, { ...tab, id: "y" }, "x", false);
    expect(ids(chained)).toEqual(["a", "b", "x", "y", "c"]);
    expect(insertTab(three(), tab, "b", true).active).toBe("x");
    // A workspace given that is gone: after the active one.
    expect(ids(insertTab(three(), tab, "gone", false))).toEqual(["a", "b", "x", "c"]);
  });

  test("Ctrl+1…8 go to that workspace, Ctrl+9 to the last; past the end nothing changes (#2831)", () => {
    expect(goToTab(three(), 0).active).toBe("a");
    expect(goToTab(three(), "last").active).toBe("c");
    expect(goToTab(three(), 5)).toEqual(three());
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
