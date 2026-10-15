import { type AppError, EntryId, type SessionEntryHead, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type OverlayControls, OverlayHost, useStableOverlayHost } from "@/overlay";
import type {
  ReadOnlyTreeLabel,
  TreeNode,
  TreeSelectorFilter,
  TreeSelectorState,
  TreeSnapshot,
} from "../contract";
import { createP4TreePanelState, P4TreePanelView } from "./tree-panel";
import { openP4TreePickerDialog, P4TreePickerDialogView } from "./tree-picker";
import { P4TreeSelectorView } from "./tree-selector";
import type { P4TreeSelectorActions } from "./tree-selector-controller";
import { useP4TreeSelectorController } from "./tree-selector-controller";
import { createP4TreeSelectorViewModel, formatTreeTimestamp } from "./tree-selector-model";

afterEach(cleanup);

const threadId = "tree-selector-thread" as ThreadId;
const rootId = "entry-root" as EntryId;
const leafId = "entry-leaf" as EntryId;
const siblingId = "entry-sibling" as EntryId;

function entry(
  id: EntryId,
  parentId: EntryId | null,
  role: string,
  content: string,
  ordinal: number,
): SessionEntryHead {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-06T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
    message: { role, content },
  };
}

function customEntry(
  id: EntryId,
  parentId: EntryId | null,
  content: string,
  ordinal: number,
): SessionEntryHead {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: `2026-10-06T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
    content,
  };
}

const leafLabel: ReadOnlyTreeLabel = {
  targetId: leafId,
  text: "Saved point",
  editable: false,
  disabledReason: "Labels can't be changed here.",
};

const tree: readonly TreeNode[] = [
  {
    entry: entry(rootId, null, "user", "Please inspect the conversation history.", 1),
    children: [
      {
        entry: entry(
          leafId,
          rootId,
          "assistant",
          "Distinctive preview content for this saved entry.",
          2,
        ),
        children: [],
        label: leafLabel,
      },
      {
        entry: entry(
          siblingId,
          rootId,
          "assistant",
          "Ordinary response from the sibling branch.",
          3,
        ),
        children: [],
      },
    ],
  },
];

function treeSnapshot(
  nodes: readonly TreeNode[] = tree,
  leaf: EntryId | null = leafId,
  labelsCapability: TreeSnapshot["labelsCapability"] = "available",
): TreeSnapshot {
  const labels: ReadOnlyTreeLabel[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.label) labels.push(node.label);
    pending.push(...node.children);
  }
  return { threadId, sessionFile: null, tree: nodes, leafId: leaf, labels, labelsCapability };
}

function selectorState(overrides: Partial<TreeSelectorState> = {}): TreeSelectorState {
  return {
    threadId,
    filter: { query: "", showLabels: true },
    selectedEntryId: leafId,
    leafId,
    isLoading: false,
    error: null,
    ...overrides,
  };
}

function staticActions(overrides: Partial<P4TreeSelectorActions> = {}): P4TreeSelectorActions {
  return {
    onFilterInput: vi.fn(),
    onToggleLabels: vi.fn(),
    onToggleShowAllEntries: vi.fn(),
    onSelectEntry: vi.fn(),
    onConfirmSelection: vi.fn(),
    onRowFocus: vi.fn(),
    onRowKeyDown: vi.fn(),
    onToggleCollapsed: vi.fn(),
    registerRowRef: vi.fn(),
    ...overrides,
  };
}

function SelectorHarness({
  initialState = selectorState(),
  snapshot = treeSnapshot(),
  unavailableReason,
  onSelectedEntryChange,
  onConfirmSelection,
  onRetry,
}: {
  readonly initialState?: TreeSelectorState;
  readonly snapshot?: TreeSnapshot | null;
  readonly unavailableReason?: string;
  readonly onSelectedEntryChange?: (entryId: EntryId) => void;
  readonly onConfirmSelection?: (entryId: EntryId) => void;
  readonly onRetry?: () => void | Promise<void>;
}) {
  const [state, setState] = useState(initialState);
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    unavailableReason,
    onFilterChange: (filter: TreeSelectorFilter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (entryId) => {
      setState((current) => ({ ...current, selectedEntryId: entryId }));
      onSelectedEntryChange?.(entryId);
    },
    onConfirmSelection: (entryId) => onConfirmSelection?.(entryId),
    onRetry,
  });
  return (
    <P4TreeSelectorView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      model={controller.viewModel}
    />
  );
}

function PickerDialogHarness({
  initialState,
  snapshot,
  close,
  onConfirm,
  title,
  description,
  confirmLabel,
}: {
  readonly initialState: TreeSelectorState;
  readonly snapshot: TreeSnapshot | null;
  readonly close: OverlayControls["close"];
  readonly onConfirm: (entryId: EntryId) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}) {
  const [state, setState] = useState(initialState);
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (entryId) =>
      setState((current) => ({ ...current, selectedEntryId: entryId })),
    onConfirmSelection: onConfirm,
  });
  return (
    <P4TreePickerDialogView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      confirmLabel={confirmLabel}
      description={description}
      model={controller.viewModel}
      onCancel={() => close("programmatic")}
      onConfirm={() => {
        close("programmatic");
        controller.actions.onConfirmSelection();
      }}
      title={title}
    />
  );
}

function PanelHarness({ onConfirm }: { readonly onConfirm?: (entryId: EntryId) => void }) {
  const overlay = useStableOverlayHost();
  const [state, setState] = useState(selectorState({ selectedEntryId: null }));
  const snapshot = treeSnapshot();
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (entryId) =>
      setState((current) => ({ ...current, selectedEntryId: entryId })),
    onConfirmSelection: (entryId) => {
      setState((current) => ({ ...current, selectedEntryId: entryId }));
      onConfirm?.(entryId);
    },
  });
  const openPicker = (trigger: HTMLButtonElement): void => {
    openP4TreePickerDialog({
      overlay,
      trigger,
      label: "Choose a message to preview",
      content: ({ close }) => (
        <PickerDialogHarness
          close={close}
          confirmLabel="Preview message"
          description="Choose a message to preview it."
          initialState={state}
          onConfirm={(entryId) => {
            setState((current) => ({ ...current, selectedEntryId: entryId }));
            onConfirm?.(entryId);
          }}
          snapshot={snapshot}
          title="Choose a message to preview"
        />
      ),
    });
  };
  return (
    <P4TreePanelView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      model={controller.viewModel}
      onOpenChange={() => {}}
      onOpenPicker={openPicker}
      state={createP4TreePanelState(controller.viewModel, { open: true, position: "right" })}
    />
  );
}

describe("P4 tree selector model and views", () => {
  test("shows only the matching messages on search, with labels and the preview", () => {
    render(<SelectorHarness />);

    expect(screen.getByRole("treeitem", { name: /Your message/ })).toBeTruthy();
    const labelled = screen.getByRole("treeitem", { name: /Saved point/ });
    expect(within(labelled).getByText("Saved point")).toBeTruthy();
    expect(screen.getAllByText("Current message").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Message preview" }).textContent).toContain(
      "Read-only",
    );
    expect(screen.getByRole("region", { name: "Message preview" }).textContent).toContain(
      "Distinctive preview content",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversation messages" }), {
      target: { value: "distinctive preview" },
    });

    expect(screen.queryByRole("treeitem", { name: /Your message/ })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /Saved point/ })).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.getByText("Showing 1 of 3 messages")).toBeTruthy();
  });

  test("supports depth-first keyboard navigation and Enter selection through the controller", () => {
    const onSelect = vi.fn();
    render(
      <SelectorHarness
        initialState={selectorState({ selectedEntryId: rootId })}
        onSelectedEntryChange={onSelect}
      />,
    );

    const root = screen.getByRole("treeitem", { name: /Your message/ });
    const leaf = screen.getByRole("treeitem", { name: /Saved point/ });
    const assistantRows = screen.getAllByRole("treeitem", { name: /Assistant message/ });
    const sibling = assistantRows[1];
    if (!sibling) throw new Error("Expected a sibling assistant message.");
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(leaf);
    fireEvent.keyDown(leaf, { key: "ArrowDown" });
    expect(document.activeElement).toBe(sibling);
    fireEvent.keyDown(sibling, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "End" });
    expect(document.activeElement).toBe(sibling);
    fireEvent.keyDown(sibling, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(siblingId);
  });
  test("supports Home and Space and resets the roving row after filtering", async () => {
    const onSelect = vi.fn();
    render(
      <SelectorHarness
        initialState={selectorState({ selectedEntryId: rootId })}
        onSelectedEntryChange={onSelect}
      />,
    );
    const filter = screen.getByRole("searchbox", { name: "Search conversation messages" });
    const root = screen.getByRole("treeitem", { name: /Your message/ });
    const sibling = screen.getByRole("treeitem", { name: /Ordinary response/ });
    sibling.focus();
    fireEvent.keyDown(sibling, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(root));
    fireEvent.keyDown(root, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(sibling));
    fireEvent.keyDown(sibling, { key: " " });
    expect(onSelect).toHaveBeenCalledWith(siblingId);

    filter.focus();
    fireEvent.change(filter, { target: { value: "Please inspect" } });
    const visibleRow = await screen.findByRole("treeitem", { name: /Your message/ });
    await waitFor(() => expect(visibleRow.getAttribute("tabindex")).toBe("0"));
    expect(document.activeElement).toBe(filter);
  });

  test("folds and unfolds branches with the left and right arrow keys", () => {
    render(<SelectorHarness />);
    const root = screen.getByRole("treeitem", { name: /Your message/ });
    expect(root.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(root.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /Saved point/ })).toBeNull();

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(root.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /Saved point/ })).toBeTruthy();
  });

  test("hides labels from both results and search when label visibility is off", () => {
    render(
      <SelectorHarness
        initialState={selectorState({ filter: { query: "saved point", showLabels: true } })}
      />,
    );
    expect(screen.getByRole("treeitem", { name: /Saved point/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide labels" }));
    expect(screen.queryByRole("treeitem", { name: /Saved point/ })).toBeNull();
    expect(screen.getByText("No messages match your search.")).toBeTruthy();
  });
  test("hides label controls and notices when the conversation has no labels", () => {
    const unlabeledTree: readonly TreeNode[] = [
      { entry: entry(rootId, null, "user", "An ordinary question.", 1), children: [] },
    ];
    const snapshot = treeSnapshot(unlabeledTree, rootId, "unavailable");
    const model = createP4TreeSelectorViewModel(snapshot, selectorState());
    expect(model.hasLabels).toBe(false);
    expect(model.labelsNotice).toBeNull();
    render(<SelectorHarness snapshot={snapshot} />);
    expect(screen.queryByRole("button", { name: /labels/i })).toBeNull();
    expect(screen.queryByText(/labels are read-only/i)).toBeNull();
  });

  test("searches by the formatted date without matching the raw timestamp", () => {
    const root = tree[0];
    if (!root) throw new Error("The conversation fixture must include a root message.");
    const dateQuery = formatTreeTimestamp(root.entry.timestamp).toLocaleLowerCase();
    const dateModel = createP4TreeSelectorViewModel(
      treeSnapshot(),
      selectorState({ filter: { query: dateQuery, showLabels: false } }),
    );
    const rawTimestampModel = createP4TreeSelectorViewModel(
      treeSnapshot(),
      selectorState({
        filter: { query: root.entry.timestamp.toLocaleLowerCase(), showLabels: false },
      }),
    );
    expect(dateModel.rows.some((row) => row.entryId === rootId)).toBe(true);
    expect(rawTimestampModel.rows).toHaveLength(0);
  });

  test("previews text parts, tool results, and non-message summaries", () => {
    const partsEntry: SessionEntryHead = {
      ...entry(rootId, null, "assistant", "", 1),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      },
    };
    const toolEntry = entry(EntryId.parse("entry-tool"), rootId, "toolResult", "Tool output", 2);
    const summaryEntry: SessionEntryHead = {
      type: "branch_summary",
      id: EntryId.parse("entry-summary"),
      parentId: null,
      timestamp: "2026-10-06T00:00:03.000Z",
      summary: "Saved branch summary",
    };
    const nodes: readonly TreeNode[] = [
      { entry: partsEntry, children: [] },
      { entry: toolEntry, children: [] },
      { entry: summaryEntry, children: [] },
    ];
    const model = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, summaryEntry.id),
      selectorState({ leafId: summaryEntry.id, selectedEntryId: null }),
    );

    // omp lists the root that holds the current leaf first, then the others in order.
    expect(model.rows.map((row) => [row.role, row.preview])).toEqual([
      ["Conversation summary", "Saved branch summary"],
      ["Assistant", "First part Second part"],
      ["Tool result", "Tool output"],
    ]);
  });

  test("an empty branch summary, omp's discard marker, says a message was discarded here", () => {
    const discardedId = EntryId.parse("entry-discarded");
    const discarded: SessionEntryHead = {
      type: "branch_summary",
      id: discardedId,
      parentId: null,
      timestamp: "2026-10-06T00:00:04.000Z",
      summary: "",
    };
    const nodes: readonly TreeNode[] = [{ entry: discarded, children: [] }];
    const model = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, discardedId),
      selectorState({ leafId: discardedId, selectedEntryId: null }),
    );

    expect(model.rows.map((row) => [row.role, row.preview])).toEqual([
      ["Conversation summary", "A message was discarded here."],
    ]);
  });

  test("shows omp's todo reminder in plain words, without the system-reminder tags", () => {
    const reminderId = EntryId.parse("entry-reminder");
    const reminder = entry(
      reminderId,
      rootId,
      "developer",
      [
        "<system-reminder>",
        "You stopped with 2 incomplete todo item(s):",
        "- Plan",
        "  - Write the thing",
        "  - Test the thing",
        "",
        "Please continue working on these tasks or mark them complete if finished.",
        "(Reminder 1/3)",
        "</system-reminder>",
      ].join("\n"),
      2,
    );
    const plain = [
      "You stopped with 2 incomplete todo item(s):",
      "- Plan",
      "  - Write the thing",
      "  - Test the thing",
      "",
      "Please continue working on these tasks or mark them complete if finished.",
      "(Reminder 1/3)",
    ].join("\n");
    const nodes: readonly TreeNode[] = [
      {
        entry: entry(rootId, null, "user", "Plan the todo list.", 1),
        children: [{ entry: reminder, children: [] }],
      },
    ];
    const model = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, reminderId),
      selectorState({ leafId: reminderId, selectedEntryId: reminderId }),
    );

    expect(model.rows.map((row) => [row.role, row.preview])).toEqual([
      ["You", "Plan the todo list."],
      ["Instruction", plain],
    ]);
    expect(model.preview?.text).toBe(plain);

    const search = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, reminderId),
      selectorState({
        leafId: reminderId,
        selectedEntryId: reminderId,
        filter: { query: "continue working", showLabels: true },
      }),
    );
    expect(search.rows.map((row) => row.entryId)).toEqual([reminderId]);
  });

  test("unwraps a system-* envelope in a developer, system or custom message", () => {
    const ruleNotice = [
      '<system-reminder reason="rule_violation" rule="no-tabs" path="src/a.ts">',
      "Use spaces, not tabs.",
      "</system-reminder>",
    ].join("\n");
    const nodes: readonly TreeNode[] = [
      {
        entry: entry(rootId, null, "system", ruleNotice, 1),
        children: [
          {
            entry: customEntry(
              EntryId.parse("entry-notice"),
              rootId,
              "<system-notice>\nThe background job finished.\n</system-notice>",
              2,
            ),
            children: [],
          },
          {
            entry: entry(
              EntryId.parse("entry-job"),
              rootId,
              "developer",
              "<system-notice>\nJob 1 is done.\n</system-notice>",
              3,
            ),
            children: [],
          },
        ],
      },
    ];
    const model = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, rootId),
      selectorState({ leafId: rootId, selectedEntryId: null }),
    );

    expect(model.rows.map((row) => [row.role, row.preview])).toEqual([
      ["System instruction", "Use spaces, not tabs."],
      ["Extension message", "The background job finished."],
      ["Instruction", "Job 1 is done."],
    ]);
  });

  test("keeps a tag a person typed or quoted, or the assistant wrote, as written", () => {
    const typed = "<system-reminder>\nWhat I typed\n</system-reminder>";
    const quoted = "Why does `</system-reminder>` show in the log?";
    const fenced =
      "Explain:\n```\n<system-reminder>\nkeep working\n</system-reminder>\n```\nthanks";
    const assistant = "The wrapper `<system-reminder>` is added by omp.";
    const nodes: readonly TreeNode[] = [
      {
        entry: entry(rootId, null, "user", quoted, 1),
        children: [
          { entry: entry(EntryId.parse("entry-typed"), rootId, "user", typed, 2), children: [] },
          { entry: entry(EntryId.parse("entry-fenced"), rootId, "user", fenced, 3), children: [] },
          {
            entry: entry(EntryId.parse("entry-assistant"), rootId, "assistant", assistant, 4),
            children: [],
          },
        ],
      },
    ];
    const snapshot = treeSnapshot(nodes, rootId);
    const model = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({ leafId: rootId, selectedEntryId: null }),
    );

    expect(model.rows.map((row) => row.preview)).toEqual([quoted, typed, fenced, assistant]);
    const search = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({
        leafId: rootId,
        selectedEntryId: null,
        filter: { query: "what i typed", showLabels: true },
      }),
    );
    expect(search.rows.map((row) => row.preview)).toEqual([typed]);
  });

  test("shows text as written unless it is exactly one envelope", () => {
    const texts = [
      "Heads up.\n<system-reminder>\nWords\n</system-reminder>",
      "<system-reminder>\nWords\n</system-reminder>\nTrailing note",
      "<system-reminder>\nFirst\n</system-reminder>\n<system-reminder>\nSecond\n</system-reminder>",
      "<system-reminder>\nWords\n</system-notice>",
      "<system-reminder-x>\nWords\n</system-reminder>",
    ];
    const lookalike = "<system-reminder>\nWords\n</system-reminder-x>";
    const nodes: readonly TreeNode[] = [
      {
        entry: entry(rootId, null, "user", "Start.", 1),
        children: [
          ...texts.map((text, index) => ({
            entry: entry(EntryId.parse(`entry-raw-${index}`), rootId, "developer", text, index + 2),
            children: [],
          })),
          {
            entry: customEntry(
              EntryId.parse("entry-lookalike"),
              rootId,
              lookalike,
              texts.length + 2,
            ),
            children: [],
          },
        ],
      },
    ];
    const model = createP4TreeSelectorViewModel(
      treeSnapshot(nodes, rootId),
      selectorState({ leafId: rootId, selectedEntryId: null }),
    );

    expect(model.rows.map((row) => row.preview)).toEqual(["Start.", ...texts, lookalike]);
  });

  test("ignores a tree snapshot from another conversation", () => {
    const staleSnapshot = { ...treeSnapshot(), threadId: ThreadId.parse("another-thread") };
    const model = createP4TreeSelectorViewModel(staleSnapshot, selectorState());
    expect(model.hasTree).toBe(false);
    expect(model.status?.kind).toBe("loading");
    expect(model.rows).toHaveLength(0);
  });

  test("maps selector lifecycle states into the production panel state", () => {
    const options = { open: true, position: "right" as const };
    const loading = createP4TreeSelectorViewModel(
      null,
      selectorState({ isLoading: true, selectedEntryId: null }),
    );
    const updating = createP4TreeSelectorViewModel(
      treeSnapshot(),
      selectorState({ isLoading: true }),
    );
    const empty = createP4TreeSelectorViewModel(
      treeSnapshot([], null),
      selectorState({ leafId: null, selectedEntryId: null }),
    );
    const unavailable = createP4TreeSelectorViewModel(
      null,
      selectorState({ selectedEntryId: null }),
      "Conversation history isn't available here.",
    );
    const error = createP4TreeSelectorViewModel(
      treeSnapshot(),
      selectorState({
        error: {
          code: "invalid_args",
          message: '[{"expected":"object","code":"invalid_type"}]',
          retryable: true,
        },
      }),
    );
    const populated = createP4TreeSelectorViewModel(treeSnapshot(), selectorState());

    expect(createP4TreePanelState(loading, options).lifecycle).toBe("loading");
    expect(createP4TreePanelState(updating, options).lifecycle).toBe("updating");
    expect(createP4TreePanelState(empty, options).lifecycle).toBe("empty");
    expect(createP4TreePanelState(unavailable, options).lifecycle).toBe("unavailable");
    expect(createP4TreePanelState(error, options)).toMatchObject({
      lifecycle: "error",
      error: { message: "Conversation history couldn't be loaded." },
    });
    expect(createP4TreePanelState(populated, options).lifecycle).toBe("populated");
  });

  test("renders only the visible window for a large conversation", () => {
    let child: TreeNode | null = null;
    let leaf: EntryId | null = null;
    const count = 3_000;
    for (let index = count - 1; index >= 0; index -= 1) {
      const id = EntryId.parse(`window-entry-${index}`);
      if (index === count - 1) leaf = id;
      child = {
        entry: entry(
          id,
          index === 0 ? null : EntryId.parse(`window-entry-${index - 1}`),
          "assistant",
          `Message ${index}`,
          index + 1,
        ),
        children: child === null ? [] : [child],
      };
    }
    if (child === null) throw new Error("The virtualized tree fixture was empty.");
    render(
      <SelectorHarness
        initialState={selectorState({ leafId: leaf, selectedEntryId: leaf })}
        snapshot={treeSnapshot([child], leaf)}
      />,
    );
    expect(screen.getAllByRole("treeitem")).toHaveLength(40);
    expect(screen.getByRole("status").textContent).toContain("3000 messages");
  });

  test("renders loading, empty, unavailable, and retryable error models", () => {
    const { rerender } = render(
      <P4TreeSelectorView
        actions={staticActions()}
        activeEntryId={null}
        model={createP4TreeSelectorViewModel(
          null,
          selectorState({ isLoading: true, selectedEntryId: null }),
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading conversation history");

    rerender(
      <P4TreeSelectorView
        actions={staticActions()}
        activeEntryId={null}
        model={createP4TreeSelectorViewModel(
          treeSnapshot([], null),
          selectorState({ leafId: null, selectedEntryId: null }),
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("No conversation messages yet");

    rerender(
      <P4TreeSelectorView
        actions={staticActions()}
        activeEntryId={null}
        model={createP4TreeSelectorViewModel(
          null,
          selectorState({ selectedEntryId: null }),
          "Conversation history isn't available here.",
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Conversation history isn't available here",
    );

    const retry = vi.fn();
    const error: AppError = {
      code: "omp_error",
      message: "History could not be loaded.",
      retryable: true,
    };
    rerender(
      <P4TreeSelectorView
        actions={staticActions({ onRetry: retry })}
        activeEntryId={null}
        model={createP4TreeSelectorViewModel(null, selectorState({ error, selectedEntryId: null }))}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Conversation history couldn't be loaded.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  test("keeps a loaded tree visible while showing a safe error message", () => {
    const error: AppError = {
      code: "invalid_args",
      message: '[{"expected":"object","code":"invalid_type"}]',
      retryable: true,
    };
    const model = createP4TreeSelectorViewModel(treeSnapshot(), selectorState({ error }));
    render(<SelectorHarness initialState={selectorState({ error })} />);
    expect(model.hasTree).toBe(true);
    expect(model.status?.message).toBe("Conversation history couldn't be loaded.");
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toContain("expected");
  });

  test("keeps filter focus during a passive history update through the controller", async () => {
    const { rerender } = render(<SelectorHarness snapshot={treeSnapshot()} />);
    const filter = screen.getByRole("searchbox", { name: "Search conversation messages" });
    filter.focus();
    const rootNode = tree[0];
    if (!rootNode) throw new Error("The conversation fixture must include a root message.");
    const nextTree = [
      {
        ...rootNode,
        children: [
          ...rootNode.children,
          {
            entry: entry(EntryId.parse("entry-new"), rootId, "assistant", "A passive update.", 4),
            children: [],
          },
        ],
      },
    ];
    rerender(<SelectorHarness snapshot={treeSnapshot(nextTree, EntryId.parse("entry-new"))} />);
    await waitFor(() => expect(document.activeElement).toBe(filter));
    expect(screen.getByRole("treeitem", { name: /current message/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("4 messages");
  });

  test("flattens a 17,000-entry conversation iteratively", () => {
    let child: TreeNode | null = null;
    let leaf: EntryId | null = null;
    const count = 17_000;
    for (let index = count - 1; index >= 0; index -= 1) {
      const id = EntryId.parse(`deep-entry-${index}`);
      if (index === count - 1) leaf = id;
      child = {
        entry: entry(
          id,
          index === 0 ? null : EntryId.parse(`deep-entry-${index - 1}`),
          "assistant",
          `Message ${index}`,
          index + 1,
        ),
        children: child === null ? [] : [child],
      };
    }
    if (child === null) throw new Error("Deep tree fixture was empty");
    const model = createP4TreeSelectorViewModel(treeSnapshot([child], leaf), selectorState());
    expect(model.rows).toHaveLength(count);
    expect(model.rows.at(-1)?.entryId).toBe(`deep-entry-${count - 1}`);
  });

  test("composes PanelShell and the app-owned picker with restored focus", async () => {
    const onConfirm = vi.fn();
    function PickerHarness() {
      return (
        <OverlayHost>
          <PanelHarness onConfirm={onConfirm} />
        </OverlayHost>
      );
    }
    render(<PickerHarness />);
    const panel = screen.getByRole("region", { name: "Conversation history" });
    expect(panel.getAttribute("data-panel-open")).toBe("true");
    const opener = screen.getByRole("button", { name: "Choose a message" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByTestId("tree-picker-dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("tree-picker-dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(opener);
    const reopenedDialog = await screen.findByTestId("tree-picker-dialog");
    const assistantRows = within(reopenedDialog).getAllByRole("treeitem", {
      name: /Assistant message/,
    });
    const sibling = assistantRows[1];
    if (!sibling) throw new Error("Expected a second assistant message.");
    fireEvent.click(sibling);
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(screen.queryByTestId("tree-picker-dialog")).toBeNull());
    expect(onConfirm).toHaveBeenCalledWith(siblingId);
    expect(document.activeElement).toBe(opener);
  });
});

describe("a marked entry the list hides cannot be chosen", () => {
  test("a search that hides the marked message disables Rewind here, and clearing it enables it", () => {
    const snapshot = treeSnapshot();
    const hidden = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({
        selectedEntryId: rootId,
        filter: { query: "saved entry", showLabels: true },
      }),
    );
    expect(hidden.rows.map((row) => row.entryId)).not.toContain(rootId);
    expect(hidden.canSelect).toBe(false);

    const shown = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({ selectedEntryId: rootId }),
    );
    expect(shown.canSelect).toBe(true);
  });

  test("a fold that hides the marked message disables Rewind here", () => {
    const folded = createP4TreeSelectorViewModel(
      treeSnapshot(),
      selectorState({ selectedEntryId: leafId }),
      undefined,
      new Set([rootId]),
    );
    expect(folded.rows.map((row) => row.entryId)).not.toContain(leafId);
    expect(folded.canSelect).toBe(false);
  });

  test("showing messages only hides a marked entry that is not one, and showing all brings it back", () => {
    const noteId = "entry-note" as EntryId;
    // A model change is bookkeeping, which omp's messages-only view does not list.
    const modelChange = {
      type: "model_change",
      id: noteId,
      parentId: rootId,
      timestamp: "2026-10-06T00:00:02.000Z",
    } as unknown as SessionEntryHead;
    const nodes: readonly TreeNode[] = [
      {
        entry: entry(rootId, null, "user", "Please inspect the conversation history.", 1),
        children: [{ entry: modelChange, children: [] }],
      },
    ];
    const snapshot = treeSnapshot(nodes, noteId);
    const messagesOnly = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({ selectedEntryId: noteId }),
    );
    expect(messagesOnly.canSelect).toBe(false);

    const everything = createP4TreeSelectorViewModel(
      snapshot,
      selectorState({ selectedEntryId: noteId }),
      undefined,
      new Set(),
      true,
    );
    expect(everything.canSelect).toBe(true);
  });
});
