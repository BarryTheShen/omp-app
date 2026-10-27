import type { ChatSessionRequest, EntryId, ThreadId } from "@omp-app/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TreeSelectorFilter, TreeSelectorState, TreeSnapshot } from "@/modules/P4/contract";
import { OmpSessionTreePort } from "@/modules/P4/history";
import { createP4LabelsViewModel, P4LabelsView } from "@/modules/P4/labels";
import {
  createP4TreePanelState,
  openP4TreePickerDialog,
  P4TreePanelView,
  P4TreePickerDialogView,
  useP4TreeSelectorController,
} from "@/modules/P4/selector";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useStableOverlayHost } from "@/overlay";
import { useRightSidebar } from "@/shell";
import { isUserMessage, rewindFailureMessage, treeEntry } from "./rewind-tree";
import { useRewindTree } from "./use-rewind-tree";

export interface RewindPanelProps {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly send: ChatSessionRequest;
  readonly labelsAvailable: boolean;
  readonly transitions: ConversationTransitionPort;
  /** Changes each time a command opens the panel again: focus moves back into the panel. */
  readonly reveal: number;
  readonly onClose: () => void;
}

const PICKER_TITLE = "Choose a message";
const PICKER_DESCRIPTION =
  "Rewind continues from before the message you mark; Fork copies the conversation up to and including it. Your current conversation is kept.";
const FORK_UNAVAILABLE_REASON = "Fork isn't available with this version of omp.";

/**
 * The rewind tree in the right-hand panel. Choosing a message (Enter on the marked one, or the
 * picker's confirm button) rewinds the conversation to it through P4's transition port, which runs
 * R0.4's branching controller. Escape closes the panel; the owner returns focus.
 */
export function RewindPanel({
  threadId,
  store,
  send,
  labelsAvailable,
  transitions,
  reveal,
  onClose,
}: RewindPanelProps): ReactNode {
  const overlay = useStableOverlayHost();
  const sidebar = useRightSidebar();
  const root = useRef<HTMLDivElement | null>(null);
  const [rootElement, setRootElement] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((element: HTMLDivElement | null) => {
    root.current = element;
    setRootElement(element);
  }, []);
  const mounted = useRef(false);
  const port = useMemo(
    () =>
      new OmpSessionTreePort({
        send,
        labelsCapability: labelsAvailable ? "available" : "unavailable",
      }),
    [labelsAvailable, send],
  );
  const tree = useRewindTree(port, threadId, store);
  const [filter, setFilter] = useState<TreeSelectorFilter>({ query: "", showLabels: true });
  const [selectedEntryId, setSelectedEntryId] = useState<EntryId | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<"rewind" | "fork" | null>(null);
  const state: TreeSelectorState = {
    threadId,
    filter,
    selectedEntryId,
    leafId: tree.snapshot?.leafId ?? null,
    isLoading: tree.isLoading,
    error: tree.error,
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rewind = (entryId: EntryId): void => {
    const snapshot = tree.snapshot;
    const entry = snapshot === null ? undefined : treeEntry(snapshot.tree, entryId);
    if (entry === undefined || !isUserMessage(entry)) {
      setFailure("Choose one of your messages to rewind to.");
      return;
    }
    if (snapshot?.leafId === entryId) {
      setFailure("The conversation already ends with this message.");
      return;
    }
    setFailure(null);
    setTransitioning("rewind");
    transitions.branch({ threadId, entryId }).then(
      () => {
        // The thread switch closes this panel; nothing else to publish here.
        if (mounted.current) setTransitioning(null);
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setTransitioning(null);
        setFailure(rewindFailureMessage(error));
      },
    );
  };

  const fork = (entryId: EntryId): void => {
    const snapshot = tree.snapshot;
    const entry = snapshot === null ? undefined : treeEntry(snapshot.tree, entryId);
    if (entry?.type !== "message") {
      setFailure("Choose a message to fork from.");
      return;
    }
    setFailure(null);
    setTransitioning("fork");
    transitions.fork({ threadId, entryId }).then(
      () => {
        if (mounted.current) setTransitioning(null);
      },
      () => {
        if (!mounted.current) return;
        setTransitioning(null);
        setFailure("The conversation couldn't be forked. Try again.");
      },
    );
  };

  const controller = useP4TreeSelectorController({
    snapshot: tree.snapshot,
    state,
    onFilterChange: setFilter,
    onSelectedEntryChange: setSelectedEntryId,
    onConfirmSelection: rewind,
    onRetry: tree.reload,
  });

  // Opening the panel shows the right sidebar it is in, and moves focus into the tree once the tree
  // is on screen. A passive update (a new turn) never moves focus.
  const shell = useRef(sidebar);
  shell.current = sidebar;
  const pendingFocus = useRef(true);
  const sidebarOpen = sidebar?.open ?? true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reveal asks for the sidebar and focus again.
  useEffect(() => {
    pendingFocus.current = true;
    const current = shell.current;
    if (current !== null && !current.open) current.show();
  }, [reveal]);
  // The controller normally marks one row as the roving tab stop. During a slow tree load it can
  // briefly render rows before that state settles; still put focus into the visible tree, then the
  // row's onFocus callback repairs the roving tab stop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus may move once a row, a reveal or a finished read arrives.
  useLayoutEffect(() => {
    if (!pendingFocus.current || !sidebarOpen) return;
    const focusRow = (): boolean => {
      if (!pendingFocus.current) return true;
      const activeRow = root.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
      const row =
        activeRow ??
        Array.from(root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []).at(-1);
      if (!row) return false;
      row.focus({ preventScroll: true });
      if (document.activeElement !== row) return false;
      pendingFocus.current = false;
      return true;
    };
    const retry = setInterval(() => {
      if (focusRow()) clearInterval(retry);
    }, 100);
    if (focusRow()) {
      clearInterval(retry);
      return () => clearInterval(retry);
    }
    const emptyTree =
      tree.snapshot !== null && !tree.isLoading && controller.viewModel.rows.length === 0;
    if (tree.error !== null || emptyTree) {
      pendingFocus.current = false;
      const next =
        root.current?.querySelector<HTMLElement>('input[type="search"]') ??
        root.current?.querySelector<HTMLElement>("button:not([disabled])");
      next?.focus({ preventScroll: true });
      clearInterval(retry);
      return;
    }
    const panelRoot = root.current;
    if (panelRoot === null) {
      return () => clearInterval(retry);
    }
    const observer = new MutationObserver(() => {
      if (focusRow()) observer.disconnect();
    });
    const observeOptions: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["aria-hidden", "data-open", "inert"],
      childList: true,
      subtree: true,
    };
    observer.observe(panelRoot, observeOptions);
    const sidebarElement = panelRoot.closest("[data-shell-sidebar]");
    if (sidebarElement !== null && sidebarElement !== panelRoot) {
      observer.observe(sidebarElement, observeOptions);
    }
    return () => {
      observer.disconnect();
      clearInterval(retry);
    };
  }, [
    controller.activeEntryId,
    controller.viewModel.rows.length,
    reveal,
    sidebarOpen,
    tree.error,
    tree.isLoading,
    rootElement,
  ]);
  const forkAvailable = transitions.getCapabilities()["omp.cmd.fork"]?.state === "available";

  const openPicker = (trigger: HTMLButtonElement): void => {
    openP4TreePickerDialog({
      overlay,
      trigger,
      label: PICKER_TITLE,
      content: ({ close }) => (
        <RewindPicker
          initialState={state}
          snapshot={tree.snapshot}
          onCancel={() => close("programmatic")}
          onConfirm={(entryId) => {
            close("programmatic");
            rewind(entryId);
          }}
          onFork={
            forkAvailable
              ? (entryId) => {
                  close("programmatic");
                  fork(entryId);
                }
              : undefined
          }
          forkUnavailableReason={forkAvailable ? undefined : FORK_UNAVAILABLE_REASON}
        />
      ),
    });
  };

  const panelState = createP4TreePanelState(controller.viewModel, {
    open: true,
    position: "right",
  });
  const labels = useMemo(
    () => (tree.snapshot === null ? null : createP4LabelsViewModel(tree.snapshot)),
    [tree.snapshot],
  );
  const footer = (
    <div className="flex min-w-0 flex-col">
      {failure !== null ? (
        <p className="text-danger px-4 py-2 text-xs" role="alert">
          {failure}
        </p>
      ) : transitioning === "rewind" ? (
        <p className="text-muted-foreground px-4 py-2 text-xs" role="status">
          Rewinding the conversation…
        </p>
      ) : transitioning === "fork" ? (
        <p className="text-muted-foreground px-4 py-2 text-xs" role="status">
          Forking the conversation…
        </p>
      ) : null}
      {labels === null ? null : (
        <div className="px-4 pb-4">
          <P4LabelsView model={labels} showReason={controller.viewModel.labelsNotice === null} />
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-rewind-panel="true" ref={setRoot}>
      <P4TreePanelView
        actions={controller.actions}
        activeEntryId={controller.activeEntryId}
        footer={footer}
        model={controller.viewModel}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onOpenPicker={openPicker}
        onRetry={tree.reload}
        state={panelState}
      />
    </div>
  );
}

interface RewindPickerProps {
  readonly initialState: TreeSelectorState;
  readonly snapshot: TreeSnapshot | null;
  readonly onCancel: () => void;
  readonly onConfirm: (entryId: EntryId) => void;
  readonly onFork?: (entryId: EntryId) => void;
  readonly forkUnavailableReason?: string;
}

/** The picker starts with the panel's marked message and offers rewind or fork from that selection. */
function RewindPicker({
  initialState,
  snapshot,
  onCancel,
  onConfirm,
  onFork,
  forkUnavailableReason,
}: RewindPickerProps) {
  const [state, setState] = useState(initialState);
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (selectedEntryId) =>
      setState((current) => ({ ...current, selectedEntryId })),
    onConfirmSelection: onConfirm,
  });
  return (
    <P4TreePickerDialogView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      confirmLabel="Rewind here"
      description={
        forkUnavailableReason === undefined
          ? PICKER_DESCRIPTION
          : `${PICKER_DESCRIPTION} ${forkUnavailableReason}`
      }
      model={controller.viewModel}
      onCancel={onCancel}
      forkDisabled={
        onFork !== undefined &&
        (snapshot === null ||
          controller.viewModel.selectedEntryId === null ||
          treeEntry(snapshot.tree, controller.viewModel.selectedEntryId)?.type !== "message")
      }
      onConfirm={controller.actions.onConfirmSelection}
      onFork={
        onFork === undefined
          ? undefined
          : () => {
              const id = controller.viewModel.selectedEntryId;
              if (controller.viewModel.canSelect && id !== null) onFork(id);
            }
      }
      title={PICKER_TITLE}
    />
  );
}
