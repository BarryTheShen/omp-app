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
 * pill above the box, and a task card's agent opens it on that agent.
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [restore, setRestore] = useState<ComposerRestore | null>(null);
  const [folds, setFolds] = useState<Folds>(NO_FOLDS);
  /** The Agent Hub, while it is open: the subagent shown, or null for the list alone. */
  const [hub, setHub] = useState<{ readonly selected: string | null } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const openAgents = useCallback(() => setHub({ selected: null }), []);
  const closeAgents = useCallback(() => {
    setHub(null);
    // The caret goes back to where Alt+A or the pill took it from.
    root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, []);
  // Task cards link the agents omp's roster knows; the ids change only when an agent comes or goes, not with progress.
  const agentIds = snapshot.agents.map((agent) => agent.id).join("\n");
  const host = useMemo<ToolRenderHost>(() => {
    const known = new Set(agentIds.split("\n"));
    return {
      hasAgent: (id) => known.has(id),
      openAgent: (id) => setHub({ selected: id }),
    };
  }, [agentIds]);
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
  const canEdit = !snapshot.working && snapshot.phase === "live";
  const actions = useMemo<RowActions>(
    () => ({
      // omp's own `/retry`: the last failed turn, again.
      onRetry: () => controller.send("/retry"),
      onSwitchModel: () => setModelPickerOpen(true),
      onStopShell: () => controller.stopShell(),
      onDismissNotice: (id) => controller.store.dismissNotice(id),
      onEdit: (entryId) => {
        controller
          .rewind(entryId)
          .then((back) => {
            if (back !== null) setRestore({ key: Date.now(), ...back });
          })
          .catch((failure: unknown) =>
            controller.store.addNotice(
              `Could not edit that message: ${failure instanceof Error ? failure.message : String(failure)}`,
              "error",
            ),
          );
      },
      canEdit,
    }),
    [controller, canEdit],
  );
  const welcome = useMemo(
    () => (controller.isNew ? { folder: controller.folder } : null),
    [controller],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
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
        disabled={snapshot.phase !== "live"}
        closed={snapshot.phase === "ended"}
        model={snapshot.model}
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
      />
      {hub !== null && (
        <AgentHub
          controller={controller}
          agents={snapshot.agents}
          selected={hub.selected}
          onSelect={(id) => setHub({ selected: id })}
          onClose={closeAgents}
        />
      )}
    </div>
  );
}
