import type { ChatHostImage } from "@omp-app/contracts/chat-host";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AgentHub } from "../agents/AgentHub";
import { ModelHub } from "../models/ModelHub";
import { PlanReview } from "../plan/PlanReview";
import { FoldContext, type Folds, NO_FOLDS } from "../vendor/collab-web/lib/fold";
import type { ToolRenderHost } from "../vendor/collab-web/tool-render/types";
import { Composer, type ComposerHandle } from "./Composer";
import type { ChatController } from "./controller";
import { HostRequests } from "./HostRequests";
import { userText } from "./MessageActions";
import { type RowActions, TranscriptList } from "./TranscriptList";

/** What Edit brings back to the message box: the message's text and images; `key` tells one edit from the next. */
export interface ComposerRestore {
  readonly key: number;
  readonly text: string;
  readonly images: readonly ChatHostImage[];
}

/**
 * One chat: its transcript, what omp waits on, and the message box. Ctrl+O opens or folds every tool card and Ctrl+T
 * shows or hides every thinking block, anywhere in the pane; Alt+A opens or closes the Agent Hub, as does the agents
 * pill above the box, and a task card's agent opens it on that agent; Ctrl+P and Shift+Ctrl+P switch to the next or
 * previous role's model, as in omp.
 */
export function ChatPane({
  controller,
  onComposer,
}: {
  readonly controller: ChatController;
  /** The message box's handle, for the palette; null once it is gone. */
  readonly onComposer?: (handle: ComposerHandle | null) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const loadOlder = useCallback(() => void controller.loadOlder(), [controller]);
  // Stable, so the role track's timer is not restarted by every render while omp streams.
  const hideRoleTrack = useCallback(
    (id: number) => controller.store.hideRoleTrack(id),
    [controller],
  );
  // Stable for the same reason: a toast's own timer ends it.
  const hideToast = useCallback((id: number) => controller.store.dismissToast(id), [controller]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [restore, setRestore] = useState<ComposerRestore | null>(null);
  /**
   * An edit on its way: omp goes back to before the message and the chat is read again, which takes a moment on a long
   * chat. Edit is offered again once it is through, so a second click cannot bring the message back twice.
   */
  const [editing, setEditing] = useState(false);
  const editingNow = useRef(false);
  const [folds, setFolds] = useState<Folds>(NO_FOLDS);
  /** The Agent Hub, while it is open: the subagent shown, or null for the list alone (the side panel opens it too). */
  const hub = useSyncExternalStore(controller.agentHub.subscribe, controller.agentHub.getSnapshot);
  const root = useRef<HTMLDivElement | null>(null);
  const openAgents = useCallback(() => controller.agentHub.open(), [controller]);
  const closeAgents = useCallback(() => {
    controller.agentHub.close();
    // The caret goes back to where Alt+A or the pill took it from.
    root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [controller]);
  // Task cards link the agents omp's roster knows; the ids change only when an agent comes or goes, not with progress.
  const agentIds = snapshot.agents.map((agent) => agent.id).join("\n");
  const host = useMemo<ToolRenderHost>(() => {
    const known = new Set(agentIds.split("\n"));
    return {
      hasAgent: (id) => known.has(id),
      openAgent: (id) => controller.agentHub.open(id),
    };
  }, [agentIds, controller]);
  const agentsRunning = snapshot.agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  // What you sent, oldest first: the message box's Up and Down go through it, as omp's history does.
  const history = useMemo(
    () =>
      snapshot.entries
        .map(userText)
        .filter((text): text is string => text !== null && text.trim() !== ""),
    [snapshot.entries],
  );
  const waiting = snapshot.requests[0];
  const approval = waiting?.method === "ui.approve" ? waiting.id : null;
  const canEdit = !snapshot.working && snapshot.phase === "live" && !editing;
  const actions = useMemo<RowActions>(
    () => ({
      // omp's own `/retry`: the last failed turn, again.
      onRetry: () => controller.send("/retry"),
      continuesAt: snapshot.continuesAt,
      onDontContinue: () => controller.cancelContinue(),
      onSwitchModel: () => setModelPickerOpen(true),
      onStopShell: () => controller.stopShell(),
      onDismissNotice: (id) => controller.store.dismissNotice(id),
      onEdit: (entryId) => {
        if (editingNow.current) return;
        editingNow.current = true;
        setEditing(true);
        controller
          .rewind(entryId)
          .then((back) => {
            if (back !== null) setRestore({ key: Date.now(), ...back });
          })
          .catch((failure: unknown) =>
            controller.store.toast(
              `Could not edit that message: ${failure instanceof Error ? failure.message : String(failure)}`,
              "error",
            ),
          )
          .finally(() => {
            editingNow.current = false;
            setEditing(false);
          });
      },
      canEdit,
    }),
    [controller, canEdit, snapshot.continuesAt],
  );
  const welcome = useMemo(
    () => (controller.isNew ? { folder: controller.folder } : null),
    [controller],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // omp's Alt+M: the Models dialog, where each role gets its model.
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.code === "KeyM"
    ) {
      event.preventDefault();
      controller.modelHubToggle.toggle();
      return;
    }
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.code === "KeyA"
    ) {
      event.preventDefault();
      if (hub === null) openAgents();
      else closeAgents();
      return;
    }
    // omp's plan mode, on or off; a refusal (work running, a goal active) is said in the transcript.
    if (
      event.altKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === "KeyP"
    ) {
      event.preventDefault();
      const planMode = snapshot.planMode;
      if (planMode === null || !planMode.available) return;
      controller
        .setPlanMode(!planMode.enabled)
        .catch((failure: unknown) =>
          controller.store.toast(
            `Plan mode: ${failure instanceof Error ? failure.message : String(failure)}`,
            "error",
          ),
        );
      return;
    }
    // omp's Ctrl+P and Shift+Ctrl+P: the next or previous role's model (smol, default, slow, as omp's roles are set).
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === "KeyP") {
      event.preventDefault();
      controller
        .cycleRole(event.shiftKey ? "backward" : "forward")
        .catch((failure: unknown) =>
          controller.store.toast(
            `Could not switch the model: ${failure instanceof Error ? failure.message : String(failure)}`,
            "error",
          ),
        );
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const which = event.code === "KeyO" ? "tools" : event.code === "KeyT" ? "thinking" : null;
    if (which === null) return;
    event.preventDefault();
    setFolds((current) => ({
      ...current,
      [which]: { open: !current[which].open, epoch: current[which].epoch + 1 },
    }));
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pane's keys, from its message box or its transcript
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <FoldContext value={folds}>
        <TranscriptList
          snapshot={snapshot}
          onNearTop={loadOlder}
          actions={actions}
          welcome={welcome}
          host={host}
        />
      </FoldContext>
      <HostRequests controller={controller} requests={snapshot.requests} />
      <Composer
        controller={controller}
        working={snapshot.working}
        pausedAt={snapshot.pausedAt}
        held={snapshot.held}
        disabled={snapshot.phase !== "live"}
        closed={snapshot.phase === "ended"}
        model={snapshot.model}
        role={snapshot.role}
        roleTrack={snapshot.roleTrack}
        onRoleTrackDone={hideRoleTrack}
        toast={snapshot.toast}
        onToastDone={hideToast}
        thinkingLevel={snapshot.thinkingLevel}
        queue={snapshot.queue}
        activity={snapshot.activity}
        modelPickerOpen={modelPickerOpen}
        onModelPickerOpenChange={setModelPickerOpen}
        restore={restore}
        history={history}
        approval={approval}
        onHandle={onComposer}
        agentsRunning={agentsRunning}
        agentsTotal={snapshot.agents.length}
        onOpenAgents={openAgents}
        todos={snapshot.todos}
        planMode={snapshot.planMode}
        goal={snapshot.goal}
      />
      {hub !== null && (
        <AgentHub
          controller={controller}
          agents={snapshot.agents}
          selected={hub.selected}
          onSelect={(id) => controller.agentHub.open(id)}
          onClose={closeAgents}
        />
      )}
      {/* omp proposed a plan: it waits for a decision while plan mode is on (a replayed, decided one never shows). */}
      {snapshot.proposal !== null && snapshot.planMode?.enabled === true && (
        <PlanReview controller={controller} proposal={snapshot.proposal} />
      )}
      {/* omp's Alt+M: the Models dialog, opened by the key or the palette. */}
      <ModelHub controller={controller} />
    </div>
  );
}
