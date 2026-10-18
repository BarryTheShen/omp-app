import type { EntryId, ThreadId } from "@omp-app/contracts";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeSelectorFilter, TreeSelectorState, TreeSnapshot } from "../contract";
import { TreeSelectorFilterSchema } from "../contract";
import type { P4TreeSelectorViewModel } from "./tree-selector-model";
import { createP4TreeSelectorViewModel } from "./tree-selector-model";

/** How many rows PageUp and PageDown move the marked row. */
const TREE_PAGE_ROWS = 10;

export interface P4TreeSelectorControllerOptions {
  readonly snapshot: TreeSnapshot | null;
  readonly state: TreeSelectorState;
  readonly unavailableReason?: string;
  readonly onFilterChange: (filter: TreeSelectorFilter) => void;
  readonly onSelectedEntryChange: (entryId: EntryId) => void;
  readonly onConfirmSelection: (entryId: EntryId) => void;
  readonly onRetry?: () => void | Promise<void>;
}

export interface P4TreeSelectorActions {
  readonly onFilterInput: (value: string) => void;
  readonly onToggleLabels: () => void;
  readonly onToggleShowAllEntries: () => void;
  readonly onSelectEntry: (entryId: EntryId) => void;
  readonly onConfirmSelection: () => void;
  readonly onRowFocus: (entryId: EntryId) => void;
  readonly onRowKeyDown: (entryId: EntryId, event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggleCollapsed: (entryId: EntryId) => void;
  readonly registerRowRef: (entryId: EntryId, element: HTMLDivElement | null) => void;
  readonly onRetry?: () => void | Promise<void>;
}

export interface P4TreeSelectorControllerModel {
  readonly viewModel: P4TreeSelectorViewModel;
  readonly activeEntryId: EntryId | null;
  readonly actions: P4TreeSelectorActions;
}

/** Folds and the show-all toggle belong to one conversation; a switch of conversation resets them. */
interface ThreadScoped<T> {
  readonly threadId: ThreadId;
  readonly value: T;
}

const EMPTY_COLLAPSED_IDS: ReadonlySet<EntryId> = new Set();

/**
 * Owns filtering, the marked entry, the roving row, folds and keyboard navigation outside the view.
 * The list opens on the marked entry (or the current one) without taking focus.
 */
export function useP4TreeSelectorController(
  options: P4TreeSelectorControllerOptions,
): P4TreeSelectorControllerModel {
  const { snapshot, state, unavailableReason } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;
  const [collapsedState, setCollapsedState] = useState<ThreadScoped<ReadonlySet<EntryId>>>(() => ({
    threadId: state.threadId,
    value: EMPTY_COLLAPSED_IDS,
  }));
  const [showAllState, setShowAllState] = useState<ThreadScoped<boolean>>(() => ({
    threadId: state.threadId,
    value: false,
  }));
  const collapsedIds =
    collapsedState.threadId === state.threadId ? collapsedState.value : EMPTY_COLLAPSED_IDS;
  const showAllEntries = showAllState.threadId === state.threadId && showAllState.value;
  const viewModel = useMemo(
    () =>
      createP4TreeSelectorViewModel(
        snapshot,
        state,
        unavailableReason,
        collapsedIds,
        showAllEntries,
      ),
    [collapsedIds, showAllEntries, snapshot, state, unavailableReason],
  );
  const viewModelRef = useRef(viewModel);
  viewModelRef.current = viewModel;
  const [activeEntryId, setActiveEntryId] = useState<EntryId | null>(viewModel.openEntryId);
  const rowRefs = useRef(new Map<EntryId, HTMLDivElement>());
  const pendingFocusId = useRef<EntryId | null>(null);
  const previousThreadId = useRef(state.threadId);
  const previousHasTree = useRef(viewModel.hasTree);

  useEffect(() => {
    const threadChanged = previousThreadId.current !== state.threadId;
    const treeLoaded = !previousHasTree.current && viewModel.hasTree;
    previousThreadId.current = state.threadId;
    previousHasTree.current = viewModel.hasTree;
    if (threadChanged || treeLoaded) {
      pendingFocusId.current = null;
      setActiveEntryId(viewModel.openEntryId);
      return;
    }
    if (viewModel.rows.some((row) => row.entryId === activeEntryId)) return;
    const selectedIsListed = viewModel.rows.some((row) => row.entryId === state.selectedEntryId);
    setActiveEntryId(
      selectedIsListed ? state.selectedEntryId : (viewModel.rows[0]?.entryId ?? null),
    );
  }, [
    activeEntryId,
    state.selectedEntryId,
    state.threadId,
    viewModel.hasTree,
    viewModel.openEntryId,
    viewModel.rows,
  ]);

  const registerRowRef = useCallback((entryId: EntryId, element: HTMLDivElement | null) => {
    if (!element) {
      rowRefs.current.delete(entryId);
      return;
    }
    rowRefs.current.set(entryId, element);
    if (pendingFocusId.current === entryId) {
      pendingFocusId.current = null;
      element.focus();
    }
  }, []);
  const onRowFocus = useCallback((entryId: EntryId) => {
    setActiveEntryId(entryId);
  }, []);
  const focusEntry = useCallback((entryId: EntryId) => {
    setActiveEntryId(entryId);
    const row = rowRefs.current.get(entryId);
    if (row) {
      pendingFocusId.current = null;
      row.focus();
    } else {
      pendingFocusId.current = entryId;
    }
  }, []);
  const onFilterInput = useCallback((value: string) => {
    pendingFocusId.current = null;
    const current = stateRef.current;
    optionsRef.current.onFilterChange(
      TreeSelectorFilterSchema.parse({
        ...current.filter,
        query: value.slice(0, 512),
      }),
    );
  }, []);
  const onToggleLabels = useCallback(() => {
    pendingFocusId.current = null;
    const current = stateRef.current;
    optionsRef.current.onFilterChange(
      TreeSelectorFilterSchema.parse({
        ...current.filter,
        showLabels: !current.filter.showLabels,
      }),
    );
  }, []);
  const onToggleShowAllEntries = useCallback(() => {
    const { threadId } = stateRef.current;
    setShowAllState((current) => ({
      threadId,
      value: !(current.threadId === threadId && current.value),
    }));
  }, []);
  const onSelectEntry = useCallback(
    (entryId: EntryId) => optionsRef.current.onSelectedEntryChange(entryId),
    [],
  );
  const onConfirmSelection = useCallback(() => {
    const current = viewModelRef.current;
    if (!current.canSelect || current.selectedEntryId === null) return;
    optionsRef.current.onConfirmSelection(current.selectedEntryId);
  }, []);
  const onToggleCollapsed = useCallback((entryId: EntryId) => {
    setCollapsedState((current) => {
      const { threadId } = stateRef.current;
      const currentIds = current.threadId === threadId ? current.value : EMPTY_COLLAPSED_IDS;
      const nextIds = new Set(currentIds);
      if (nextIds.has(entryId)) nextIds.delete(entryId);
      else nextIds.add(entryId);
      return { threadId, value: nextIds };
    });
  }, []);
  const onRowKeyDown = useCallback(
    (entryId: EntryId, event: KeyboardEvent<HTMLDivElement>) => {
      const treeChord =
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        event.ctrlKey !== event.altKey &&
        !event.metaKey &&
        !event.shiftKey;
      if (treeChord) event.preventDefault();
      const { rows, canSelect, selectedEntryId } = viewModelRef.current;
      const index = rows.findIndex((row) => row.entryId === entryId);
      const item = rows[index];
      if (!item) return;
      const modifierNavigation = treeChord;
      const plainNavigation = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      let target: EntryId | null = null;
      switch (event.key) {
        case "ArrowRight": {
          if (!plainNavigation && !modifierNavigation) return;
          if (item.hasVisibleChildren && item.collapsed) {
            event.preventDefault();
            onToggleCollapsed(entryId);
            return;
          }
          const next = rows[index + 1];
          if (next?.parentId === entryId) target = next.entryId;
          break;
        }
        case "ArrowLeft":
          if (!plainNavigation && !modifierNavigation) return;
          if (item.hasVisibleChildren && !item.collapsed) {
            event.preventDefault();
            onToggleCollapsed(entryId);
            return;
          }
          target = item.parentId;
          break;
        case "ArrowDown":
          target = rows[index + 1]?.entryId ?? null;
          break;
        case "ArrowUp":
          target = rows[index - 1]?.entryId ?? null;
          break;
        case "Home":
          target = rows[0]?.entryId ?? null;
          break;
        case "End":
          target = rows.at(-1)?.entryId ?? null;
          break;
        case "PageDown":
          target = rows[Math.min(rows.length - 1, index + TREE_PAGE_ROWS)]?.entryId ?? null;
          break;
        case "PageUp":
          target = rows[Math.max(0, index - TREE_PAGE_ROWS)]?.entryId ?? null;
          break;
        case "Enter":
          // The first Enter marks a row; Enter on the marked row confirms it.
          event.preventDefault();
          if (canSelect && selectedEntryId === entryId) {
            optionsRef.current.onConfirmSelection(entryId);
          } else {
            optionsRef.current.onSelectedEntryChange(entryId);
          }
          return;
        case " ":
        case "Spacebar":
          event.preventDefault();
          optionsRef.current.onSelectedEntryChange(entryId);
          return;
        default:
          return;
      }
      if (target !== null) {
        event.preventDefault();
        focusEntry(target);
      }
    },
    [focusEntry, onToggleCollapsed],
  );
  const actions = useMemo<P4TreeSelectorActions>(
    () => ({
      onFilterInput,
      onToggleLabels,
      onToggleShowAllEntries,
      onSelectEntry,
      onConfirmSelection,
      onRowFocus,
      onRowKeyDown,
      onToggleCollapsed,
      registerRowRef,
      onRetry: options.onRetry,
    }),
    [
      onConfirmSelection,
      onFilterInput,
      onRowFocus,
      onRowKeyDown,
      onSelectEntry,
      onToggleCollapsed,
      onToggleLabels,
      onToggleShowAllEntries,
      options.onRetry,
      registerRowRef,
    ],
  );

  return { viewModel, activeEntryId, actions };
}
