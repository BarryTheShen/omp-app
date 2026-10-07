import type { EntryId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TreeSelectorState, TreeSnapshot } from "../contract";
import {
  fixtureSnapshot,
  longChatSession,
  OmpSessionBuilder,
  type OmpSessionFixture,
  reviewSession,
} from "./omp-session-fixture";
import { P4TreeSelectorView } from "./tree-selector";
import { useP4TreeSelectorController } from "./tree-selector-controller";
import { createP4TreeSelectorViewModel } from "./tree-selector-model";

afterEach(cleanup);

// Every conversation here is written the way omp's session manager writes it (see
// omp-session-fixture.ts) and read through the app's own omp adapter, so the list sees omp's shapes.

function listState(
  snapshot: TreeSnapshot,
  selectedEntryId: EntryId | null = snapshot.leafId,
): TreeSelectorState {
  return {
    threadId: snapshot.threadId,
    filter: { query: "", showLabels: true },
    selectedEntryId,
    leafId: snapshot.leafId,
    isLoading: false,
    error: null,
  };
}

function OmpListHarness({
  snapshot,
  onConfirm,
}: {
  readonly snapshot: TreeSnapshot;
  readonly onConfirm?: (entryId: EntryId) => void;
}) {
  const [state, setState] = useState(() => listState(snapshot));
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (selectedEntryId) =>
      setState((current) => ({ ...current, selectedEntryId })),
    onConfirmSelection: (entryId) => onConfirm?.(entryId),
  });
  return (
    <P4TreeSelectorView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      model={controller.viewModel}
    />
  );
}

async function renderOmpList(
  fixture: OmpSessionFixture,
  onConfirm?: (entryId: EntryId) => void,
): Promise<TreeSnapshot> {
  const snapshot = await fixtureSnapshot(fixture);
  render(<OmpListHarness snapshot={snapshot} onConfirm={onConfirm} />);
  return snapshot;
}

function rowElement(entryId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-tree-entry-id="${entryId}"]`);
  if (!element) throw new Error(`No rendered row for ${entryId}.`);
  return element;
}

function listedIds(snapshot: TreeSnapshot): EntryId[] {
  return createP4TreeSelectorViewModel(snapshot, listState(snapshot)).rows.map(
    (row) => row.entryId,
  );
}

describe("omp's session shape in the conversation list", () => {
  test("a straight chain of 80 messages stays flat and opens on the current message", async () => {
    const session = new OmpSessionBuilder();
    session.modelChange("anthropic/claude-sonnet-5");
    session.thinkingLevelChange("medium");
    let current = "";
    for (let index = 1; index <= 80; index += 1) {
      current =
        index % 2 === 1
          ? session.user(`Question ${index}.`)
          : session.assistant(`Answer ${index}.`);
    }
    const snapshot = await renderOmpList(session.build());
    const model = createP4TreeSelectorViewModel(snapshot, listState(snapshot));

    expect(model.rows).toHaveLength(80);
    expect(model.rows.every((row) => row.depth === 0)).toBe(true);
    expect(model.rows.some((row) => row.hasVisibleChildren)).toBe(false);
    expect(model.openEntryId).toBe(current);
    expect(model.resultSummary).toBe("80 messages");
    expect(rowElement(current).getAttribute("tabindex")).toBe("0");
    for (const item of screen.getAllByRole("treeitem")) {
      expect(item.getAttribute("aria-level")).toBe("1");
      expect(item.hasAttribute("aria-expanded")).toBe(false);
    }
  });

  test("indents only below a message with several replies, as omp's terminal does", async () => {
    const session = new OmpSessionBuilder();
    const root = session.user("Plan the release.");
    const optionA = session.assistant("Option A: ship on Friday.");
    const whyFriday = session.user("Why Friday?");
    session.branchFrom(root);
    const optionB = session.assistant("Option B: ship on Monday.");
    const followUp = session.user("Then what about the tests?");
    const answer = session.assistant("Run the tests first.");
    const snapshot = await fixtureSnapshot(session.build());
    const model = createP4TreeSelectorViewModel(snapshot, listState(snapshot));

    // The branch the leaf is on is listed first; the single-reply chains stay at their parent's depth.
    expect(model.rows.map((row) => row.entryId)).toEqual([
      root,
      optionB,
      followUp,
      answer,
      optionA,
      whyFriday,
    ]);
    expect(model.rows.map((row) => row.depth)).toEqual([0, 1, 1, 1, 1, 1]);
    expect(model.rows.find((row) => row.entryId === root)?.hasVisibleChildren).toBe(true);
    expect(model.rows.find((row) => row.entryId === optionB)?.hasVisibleChildren).toBe(false);
  });

  test("hides settings, label and tool-call-only rows by default, and counts only messages", async () => {
    const snapshot = await fixtureSnapshot(reviewSession());
    const defaults = createP4TreeSelectorViewModel(snapshot, listState(snapshot));

    expect(defaults.rows.map((row) => row.role)).toEqual([
      "You",
      "Tool result",
      "Assistant",
      "You",
      "Assistant",
    ]);
    expect(defaults.resultSummary).toBe("5 messages");

    const everything = createP4TreeSelectorViewModel(
      snapshot,
      listState(snapshot),
      undefined,
      undefined,
      true,
    );
    expect(everything.rows.map((row) => row.role)).toEqual([
      "Model change",
      "Thinking level change",
      "Title change",
      "You",
      "Tool result",
      "Assistant",
      "Label",
      "You",
      "Assistant",
    ]);
    expect(everything.resultSummary).toBe("9 entries");
    expect(everything.rows.some((row) => row.preview === "No message text is available.")).toBe(
      false,
    );
  });

  test("keeps a failed turn and the current turn even when they have no text", async () => {
    const session = new OmpSessionBuilder();
    const question = session.user("Deploy the build.");
    const failed = session.failedTurn("upstream timeout");
    const pending = session.toolCall("bash", { command: "deploy" });
    const snapshot = await fixtureSnapshot(session.build());
    const model = createP4TreeSelectorViewModel(snapshot, listState(snapshot));

    expect(model.rows.map((row) => row.entryId)).toEqual([question, failed, pending.entryId]);
    expect(model.rows.at(-1)?.currentLeaf).toBe(true);
  });

  test("a label shows on its message in the list, and a label removed later is gone", async () => {
    const session = new OmpSessionBuilder();
    session.user("Which database?");
    const answer = session.assistant("Postgres, for the transactions.");
    session.label(answer, "Decision");
    await renderOmpList(session.build());
    expect(within(rowElement(answer)).getByText("Decision")).toBeTruthy();

    const removed = new OmpSessionBuilder();
    removed.user("Which database?");
    const removedAnswer = removed.assistant("Postgres, for the transactions.");
    removed.label(removedAnswer, "Draft");
    removed.label(removedAnswer, undefined);
    const removedSnapshot = await fixtureSnapshot(removed.build());
    const model = createP4TreeSelectorViewModel(removedSnapshot, listState(removedSnapshot));
    expect(model.rows.find((row) => row.entryId === removedAnswer)?.label).toBeUndefined();
    expect(model.hasLabels).toBe(false);
  });

  test("a search lists only the matching messages, not the messages above them", async () => {
    const snapshot = await fixtureSnapshot(longChatSession(80));
    const searched = createP4TreeSelectorViewModel(snapshot, {
      ...listState(snapshot),
      filter: { query: "answer 76", showLabels: true },
    });

    expect(searched.rows.map((row) => row.preview)).toEqual(["Answer 76 about the conversation."]);
    expect(searched.resultSummary).toBe(`Showing 1 of ${searched.totalCount} messages`);
  });

  test("a search with several words needs every word, in any order, as omp's terminal does", async () => {
    const session = new OmpSessionBuilder();
    session.user("Plan the release tests.");
    session.assistant("Ship the release on Friday.");
    session.user("Write the test plan for the database.");
    const snapshot = await fixtureSnapshot(session.build());
    const search = (query: string) =>
      createP4TreeSelectorViewModel(snapshot, {
        ...listState(snapshot),
        filter: { query, showLabels: true },
      }).rows.map((row) => row.preview);

    // Both words appear in the first and the third message, in a different order in each.
    expect(search("tests plan")).toEqual(["Plan the release tests."]);
    expect(search("plan test")).toEqual([
      "Plan the release tests.",
      "Write the test plan for the database.",
    ]);
    expect(search("release friday")).toEqual(["Ship the release on Friday."]);
    expect(search("  PLAN   database ")).toEqual(["Write the test plan for the database."]);
    expect(search("plan friday")).toEqual([]);
  });

  test("search results count their own places, so a screen reader hears 'n of m' across the list", async () => {
    const session = new OmpSessionBuilder();
    const root = session.user("Plan the release first.");
    session.assistant("Option A: plan a Friday launch.");
    session.branchFrom(root);
    session.assistant("Option B: plan a Monday launch.");
    session.user("Plan the tests then.");
    const snapshot = await fixtureSnapshot(session.build());
    const searched = createP4TreeSelectorViewModel(snapshot, {
      ...listState(snapshot),
      filter: { query: "plan", showLabels: true },
    });

    // Four results at three different depths in the tree, listed as one flat list of four.
    expect(searched.rows).toHaveLength(4);
    expect(searched.rows.map((row) => [row.position, row.siblingCount])).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
    ]);
  });

  test("a search lists its matches flat, so every ARIA level has a parent", async () => {
    const session = new OmpSessionBuilder();
    const root = session.user("Plan the release.");
    session.assistant("Option A: ship on Friday.");
    session.branchFrom(root);
    const optionB = session.assistant("Option B: ship on Monday.");
    session.user("Then what about the tests?");
    const snapshot = await fixtureSnapshot(session.build());
    const unsearched = createP4TreeSelectorViewModel(snapshot, listState(snapshot));
    const searched = createP4TreeSelectorViewModel(snapshot, {
      ...listState(snapshot),
      filter: { query: "option b", showLabels: true },
    });

    expect(unsearched.rows.find((row) => row.entryId === optionB)?.depth).toBe(1);
    expect(searched.rows.map((row) => row.entryId)).toEqual([optionB]);
    expect(searched.rows.every((row) => row.depth === 0 && !row.hasVisibleChildren)).toBe(true);
  });

  test("a session with only its opening settings says no messages yet", async () => {
    const session = new OmpSessionBuilder();
    session.modelChange("anthropic/claude-sonnet-5");
    session.thinkingLevelChange("medium");
    const snapshot = await fixtureSnapshot(session.build());
    const model = createP4TreeSelectorViewModel(snapshot, listState(snapshot));

    expect(model.rows).toHaveLength(0);
    expect(model.emptyListMessage).toBe("No messages yet.");
    expect(model.openEntryId).toBeNull();
  });
});

describe("the conversation list, on omp's real shapes", () => {
  test("a 26-line message is previewed in a bounded scroll box and listed as one line", async () => {
    await renderOmpList(reviewSession());

    const preview = screen.getByRole("region", { name: "Message preview" });
    expect(preview.textContent).toContain("25. Read entry 75");
    expect(preview.parentElement?.className).toContain("overflow-y-auto");
    expect(preview.parentElement?.className).toContain("max-h-56");
    const row = screen.getByRole("treeitem", { name: /Assistant message, Here is the check/ });
    const detail = row.querySelector("[title^='Here is the check']");
    expect(detail?.getAttribute("title")?.length ?? 0).toBeLessThanOrEqual(145);
  });

  test("the labels notice is one sentence shared with the other label surfaces", async () => {
    await renderOmpList(reviewSession());
    expect(screen.getByText("Labels can only be changed in omp's terminal for now.")).toBeTruthy();
  });

  test("the list opens with the current message as its tab stop", async () => {
    const snapshot = await renderOmpList(longChatSession(80));
    const ids = listedIds(snapshot);
    const current = ids.at(-1);
    expect(current).toBeDefined();
    if (!current) throw new Error("The conversation has no listed message.");
    expect(rowElement(current).getAttribute("tabindex")).toBe("0");
    expect(rowElement(current).getAttribute("aria-selected")).toBe("true");
  });

  test("the first Enter marks a message, and Enter on the marked message confirms it", async () => {
    const onConfirm = vi.fn();
    await renderOmpList(reviewSession(), onConfirm);
    const compare = screen.getByRole("treeitem", { name: /Your message, Compare the earlier/ });
    compare.focus();

    fireEvent.keyDown(compare, { key: "Enter" });
    expect(compare.getAttribute("aria-selected")).toBe("true");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(compare, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(compare.getAttribute("data-tree-entry-id"));
  });

  test("PageDown and PageUp move the active message by ten rows", async () => {
    const snapshot = await renderOmpList(longChatSession(80));
    const ids = listedIds(snapshot);
    const last = ids.at(-1);
    if (!last) throw new Error("The conversation has no listed message.");

    fireEvent.keyDown(rowElement(last), { key: "Home" });
    expect(document.activeElement).toBe(rowElement(ids[0] ?? last));

    fireEvent.keyDown(rowElement(ids[0] ?? last), { key: "PageDown" });
    expect(document.activeElement).toBe(rowElement(ids[10] ?? last));

    fireEvent.keyDown(rowElement(ids[10] ?? last), { key: "PageUp" });
    expect(document.activeElement).toBe(rowElement(ids[0] ?? last));
  });

  test("ArrowLeft in a straight chain moves to the message above instead of folding", async () => {
    const snapshot = await renderOmpList(longChatSession(20));
    const model = createP4TreeSelectorViewModel(snapshot, listState(snapshot));
    const row = model.rows.at(-2);
    const above = model.rows.at(-3);
    if (!row || !above) throw new Error("The chain is too short for this check.");
    const before = screen.getAllByRole("treeitem").length;

    fireEvent.keyDown(rowElement(row.entryId), { key: "ArrowLeft" });

    expect(document.activeElement).toBe(rowElement(above.entryId));
    expect(screen.getAllByRole("treeitem")).toHaveLength(before);
  });
});
