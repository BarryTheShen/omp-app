import type { ThreadId } from "@omp-app/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { WorkspaceGuarantee } from "../contract";
import type { P3Runs } from "./runs";
import type { P3FailedState, P3RunState, P3SentState } from "./status";

/**
 * What a restore the app managed says about the files. A run that no restore managed says nothing about files: none was
 * attempted, and omp's branch only moves the conversation (issue 1379).
 */
const RESTORE_COPY: Record<Exclude<WorkspaceGuarantee, "not-managed">, string> = {
  boundary: "Workspace files were restored to the last checkpoint.",
  exact: "Workspace files were restored to the state before this message.",
};

type ActiveRunState = Exclude<P3RunState, { readonly phase: "idle" }>;

/** A run's status belongs to the chats it touched: the source chat, and the new chat once omp opened one. */
function belongsTo(state: ActiveRunState, threadId: ThreadId): boolean {
  if (state.phase === "sending") return state.sourceThreadId === threadId;
  if (state.phase === "sent")
    return state.sourceThreadId === threadId || state.threadId === threadId;
  return state.sourceThreadId === threadId || state.chatThreadId === threadId;
}

function SentNotice({
  state,
  inNewChat,
}: {
  readonly state: P3SentState;
  readonly inNewChat: boolean;
}) {
  const verb = state.kind === "edit" ? "Sent" : "Answered again";
  // The notice shows in both chats a run touched, so it must say which of the two the reader is in.
  const where = inNewChat
    ? "in this new chat, branched from the original"
    : "in a new chat branched from this one";
  if (!state.settled) {
    const pending = state.kind === "edit" ? "edited message" : "new answer";
    const pendingSentence = inNewChat
      ? `Waiting for the ${pending} to finish in this chat.`
      : `The ${pending} was sent in a new chat branched from this one. Its final answer is not available here yet.`;
    return (
      <div className="flex flex-col gap-1" role="status">
        <p>{pendingSentence}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" role="status">
      <p>
        {state.workspaceGuarantee === "not-managed"
          ? `${verb} ${where}.`
          : `${verb} ${where}. ${RESTORE_COPY[state.workspaceGuarantee]}`}
      </p>
      {state.partialFailure ? (
        <p className="text-danger">{`Some workspace files could not be restored: ${state.partialFailure}`}</p>
      ) : null}
      {state.externalChanges.length > 0 ? (
        <p className="text-muted-foreground">
          {`Changed outside omp: ${state.externalChanges.join(", ")}`}
        </p>
      ) : null}
    </div>
  );
}

function FailedNotice({
  state,
  canRetry,
  onRetry,
}: {
  readonly state: P3FailedState;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <InlineError
        message={state.message}
        onRetry={canRetry ? onRetry : undefined}
        retryLabel="Try again"
        variant="compact"
      />
      {state.kind === "edit" ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">Your text is kept here:</p>
          <p
            className="border-border whitespace-pre-wrap break-words rounded-md border p-2"
            data-slot="p3-run-kept-text"
          >
            {state.replacement.text}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export interface P3RunStatusViewProps {
  readonly state: ActiveRunState;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly showOpenSource: boolean;
  readonly onOpenSource: () => void;
  readonly onDismiss: () => void;
  readonly openError: string | null;
}

/** What a run is doing, what changed on disk, and the way back. Placement-free: the layout decides where it sits. */
export function P3RunStatusView({
  state,
  canRetry,
  onRetry,
  showOpenSource,
  onOpenSource,
  openError,
  onDismiss,
}: P3RunStatusViewProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm" data-slot="p3-run-status">
      {state.phase === "sending" ? (
        <p className="text-muted-foreground" role="status">
          {state.kind === "edit"
            ? "Sending the edited message as a new branch…"
            : "Asking again as a new branch…"}
        </p>
      ) : null}
      {state.phase === "sent" ? <SentNotice inNewChat={showOpenSource} state={state} /> : null}
      {state.phase === "failed" ? (
        <FailedNotice canRetry={canRetry} onRetry={onRetry} state={state} />
      ) : null}
      {showOpenSource || state.phase !== "sending" ? (
        <div className="flex flex-wrap items-center gap-2">
          {showOpenSource ? (
            <Button onClick={onOpenSource} size="sm" type="button" variant="outline">
              Open the original chat
            </Button>
          ) : null}
          {state.phase !== "sending" ? (
            <Button onClick={onDismiss} size="sm" type="button" variant="ghost">
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      {openError ? (
        <p className="text-danger" role="alert">
          {openError}
        </p>
      ) : null}
    </div>
  );
}

export interface P3RunStatusSurfaceProps {
  readonly runs: P3Runs;
  /** The chat this surface is shown in. */
  readonly threadId: ThreadId;
  readonly onRetry: (failure: P3FailedState) => Promise<void>;
  readonly onOpenSource: (threadId: ThreadId) => Promise<void>;
}

/** The run status for one open chat. It is shown only while the chat is one the run touched. */
export function P3RunStatusSurface({
  runs,
  threadId,
  onRetry,
  onOpenSource,
}: P3RunStatusSurfaceProps) {
  const state = useSyncExternalStore(
    runs.status.subscribe,
    runs.status.getSnapshot,
    runs.status.getSnapshot,
  );
  const [openError, setOpenError] = useState<string | null>(null);
  // A notice belongs to the chats its run touched. Opening any other chat ends the notice.
  useEffect(() => {
    if (state.phase !== "idle" && !belongsTo(state, threadId)) runs.status.dismiss();
  }, [runs.status, state, threadId]);
  if (state.phase === "idle" || !belongsTo(state, threadId)) return null;
  // A retry runs in the chat it belongs to, where this surface's handlers are live.
  const canRetry = state.phase === "failed" && state.retryable && state.chatThreadId === threadId;
  return (
    <P3RunStatusView
      canRetry={canRetry}
      onOpenSource={() => {
        setOpenError(null);
        onOpenSource(state.sourceThreadId).catch(() => {
          setOpenError("The original chat could not be opened.");
        });
      }}
      onRetry={() => {
        if (state.phase === "failed") void onRetry(state);
      }}
      openError={openError}
      onDismiss={() => runs.status.dismiss()}
      showOpenSource={state.sourceThreadId !== threadId}
      state={state}
    />
  );
}
