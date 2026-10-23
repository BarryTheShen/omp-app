import type { ToolCallId } from "@omp-app/contracts";
import { createContext } from "react";
import { EmptyState, InlineError } from "@/components/blocks";
import { type ToolRendererMap, ToolRunActiveContext } from "@/modules/U1/tool-slots";
import { NestedTranscript } from "@/modules/U3/tool-card/nested";
import type { TranscriptView } from "./controller";
import { transcriptFailureNotice, UNSAVED_TRANSCRIPT_NOTICE } from "./failures";

/** True inside a worker's transcript body: a task card there is a worker that a worker started. */
export const WorkerTranscriptScope = createContext(false);

export interface AgentTranscriptBodyProps {
  readonly transcript: TranscriptView;
  /** The nesting level of the card or thread that shows this transcript. */
  readonly depth: number;
  readonly parentTaskId?: ToolCallId;
  readonly taskName?: string;
  readonly toolRenderers?: ToolRendererMap;
}

/**
 * One worker's transcript as a block: the messages through U3's read-only nested composition, and
 * every state the tail can be in (loading, nothing recorded yet, a failed read, live updates paused)
 * as a visible row. Nothing here can change the worker.
 */
export function AgentTranscriptBody({
  transcript,
  depth,
  parentTaskId,
  taskName,
  toolRenderers,
}: AgentTranscriptBodyProps) {
  const { messages, loading, failure, liveFailure, agentStatus, sessionFileKnown, refresh } =
    transcript;
  const working = agentStatus === "running" || agentStatus === "pending";
  const worker = { finished: !working, sessionFileKnown };
  // An empty page with nothing failed. A live worker may still write its first message; an ended one never will.
  const emptyPage = !loading && failure === undefined && messages.length === 0;
  const unsaved = emptyPage && !working;
  const notice =
    failure !== undefined
      ? transcriptFailureNotice(failure, worker)
      : unsaved
        ? UNSAVED_TRANSCRIPT_NOTICE
        : undefined;
  return (
    <WorkerTranscriptScope.Provider value>
      <div
        className="flex min-w-0 flex-col gap-3 px-4 py-3"
        data-agent-status={agentStatus}
        data-slot="p1-agent-transcript"
      >
        {notice !== undefined ? (
          <InlineError
            heading={notice.heading}
            message={notice.message}
            onRetry={notice.canRetry ? refresh : undefined}
            retryLabel="Try again"
            variant="compact"
          />
        ) : null}
        {liveFailure !== undefined ? (
          <p className="text-muted-foreground text-xs" data-slot="p1-live-paused" role="status">
            Live updates are paused. The transcript still refreshes every few seconds.
          </p>
        ) : null}
        {loading && failure === undefined ? (
          <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
            Loading the transcript…
          </p>
        ) : null}
        {emptyPage && working ? (
          <EmptyState
            hint="Messages appear here as the worker writes them."
            title="No messages yet"
            variant="compact"
          />
        ) : null}
        {messages.length > 0 ? (
          <ToolRunActiveContext.Provider value={working}>
            <NestedTranscript
              depth={depth}
              messages={messages}
              parentTaskId={parentTaskId}
              taskName={taskName}
              toolRenderers={toolRenderers}
            />
          </ToolRunActiveContext.Provider>
        ) : null}
      </div>
    </WorkerTranscriptScope.Provider>
  );
}
