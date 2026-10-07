import { EntryId } from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { OverlayControls } from "@/overlay";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import type { TreeSelectorFilter, TreeSelectorState, TreeSnapshot } from "../contract";
import {
  createP4TreePanelState,
  openP4TreePickerDialog,
  P4TreePanelView,
  P4TreePickerDialogView,
  useP4TreeSelectorController,
} from ".";
import {
  fixtureSnapshot,
  longChatSession,
  type OmpSessionFixture,
  reviewSession,
} from "./omp-session-fixture";

const parameters = new URLSearchParams(window.location.search);
const requestedCount = Number(parameters.get("entries"));
// Both conversations are written the way omp writes them, then read through the app's adapter.
const scenario: OmpSessionFixture =
  Number.isInteger(requestedCount) && requestedCount > 4
    ? longChatSession(requestedCount)
    : reviewSession();
const leafId = scenario.leafId === null ? null : EntryId.parse(scenario.leafId);
const loadLate = parameters.get("load") === "late";
const sidebarLayout = parameters.get("panel") === "sidebar";
const branchAction = parameters.get("action") === "branch";
const dialogTitle = branchAction ? "Choose where to branch" : "Choose a message to preview";
const dialogDescription = branchAction
  ? "Start a separate conversation from this message. The original conversation stays unchanged."
  : "Choose a message to preview it.";
const confirmLabel = branchAction ? "Start branch" : "Preview message";

function initialState(isLoading: boolean): TreeSelectorState {
  return {
    threadId: scenario.threadId,
    filter: { query: "", showLabels: true },
    selectedEntryId: leafId,
    leafId,
    isLoading,
    error: null,
  };
}

function PickerPlayground({
  initialSelectorState,
  snapshot,
  onConfirm,
  close,
}: {
  readonly initialSelectorState: TreeSelectorState;
  readonly snapshot: TreeSnapshot | null;
  readonly onConfirm: (entryId: EntryId) => void;
  readonly close: OverlayControls["close"];
}) {
  const [state, setState] = useState(initialSelectorState);
  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter: TreeSelectorFilter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (selectedEntryId) =>
      setState((current) => ({ ...current, selectedEntryId })),
    onConfirmSelection: (selectedEntryId) => {
      onConfirm(selectedEntryId);
      close("programmatic");
    },
  });
  return (
    <P4TreePickerDialogView
      actions={controller.actions}
      activeEntryId={controller.activeEntryId}
      confirmLabel={confirmLabel}
      description={dialogDescription}
      model={controller.viewModel}
      onCancel={() => close("programmatic")}
      onConfirm={controller.actions.onConfirmSelection}
      title={dialogTitle}
    />
  );
}

function PlaygroundContent() {
  const overlay = useStableOverlayHost();
  const [open, setOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [state, setState] = useState(() => initialState(true));
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        fixtureSnapshot(scenario).then(
          (loaded) => {
            if (cancelled) return;
            setSnapshot(loaded);
            setState((current) => ({ ...current, isLoading: false }));
          },
          (error: unknown) => {
            if (cancelled) return;
            setState((current) => ({
              ...current,
              isLoading: false,
              error: {
                code: "internal",
                message: error instanceof Error ? error.message : "The fixture failed to load.",
                retryable: false,
              },
            }));
          },
        );
      },
      loadLate ? 400 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const controller = useP4TreeSelectorController({
    snapshot,
    state,
    onFilterChange: (filter: TreeSelectorFilter) => setState((current) => ({ ...current, filter })),
    onSelectedEntryChange: (selectedEntryId) =>
      setState((current) => ({ ...current, selectedEntryId })),
    onConfirmSelection: (selectedEntryId) =>
      setState((current) => ({ ...current, selectedEntryId })),
  });
  const openPicker = (trigger: HTMLButtonElement): void => {
    openP4TreePickerDialog({
      overlay,
      trigger,
      label: dialogTitle,
      content: ({ close }) => (
        <PickerPlayground
          close={close}
          initialSelectorState={state}
          onConfirm={(selectedEntryId) => setState((current) => ({ ...current, selectedEntryId }))}
          snapshot={snapshot}
        />
      ),
    });
  };

  return (
    <main className="flex h-dvh min-h-0 w-full bg-background text-foreground">
      {!open ? (
        <div className="shrink-0 p-(--space-lg)">
          <Button type="button" onClick={() => setOpen(true)}>
            Open conversation history
          </Button>
        </div>
      ) : null}
      <aside className={sidebarLayout ? "h-dvh w-72 shrink-0" : "h-dvh min-w-0 flex-1"}>
        <P4TreePanelView
          actions={controller.actions}
          activeEntryId={controller.activeEntryId}
          model={controller.viewModel}
          onOpenChange={(nextOpen) => setOpen(nextOpen)}
          onOpenPicker={openPicker}
          showStateMessages={false}
          state={createP4TreePanelState(controller.viewModel, { open, position: "right" })}
        />
      </aside>
    </main>
  );
}

function Playground() {
  return (
    <OverlayHost>
      <PlaygroundContent />
    </OverlayHost>
  );
}

const root = document.getElementById("p4-tree-playground-root");
if (!root) throw new Error("P4 tree playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
