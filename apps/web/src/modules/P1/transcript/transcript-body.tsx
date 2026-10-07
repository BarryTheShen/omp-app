import type { ToolCallId } from "@omp-app/contracts";
import { EmptyState, InlineError } from "@/components/blocks";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import { NestedTranscript } from "@/modules/U3/tool-card/nested";
import type { TranscriptView } from "./controller";
import { transcriptFailureMessage } from "./failures";

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
  const { messages, loading, failure, liveFailure, agentStatus, refresh } = transcript;
  const working = agentStatus === "running" || agentStatus === "pending";
  return (
    <div
      className="flex min-w-0 flex-col gap-3 px-4 py-3"
      data-agent-status={agentStatus}
      data-slot="p1-agent-transcript"
    >
      {failure !== undefined ? (
        <InlineError
          heading="The transcript could not be read"
          message={transcriptFailureMessage(failure)}
          onRetry={refresh}
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
      {!loading && messages.length === 0 && failure === undefined ? (
        <EmptyState
          hint={
            working
              ? "Messages appear here as the worker writes them."
              : "This worker finished without writing a message."
          }
          title={working ? "No messages yet" : "No messages were recorded"}
          variant="compact"
        />
      ) : null}
      {messages.length > 0 ? (
        <NestedTranscript
          depth={depth}
          messages={messages}
          parentTaskId={parentTaskId}
          taskName={taskName}
          toolRenderers={toolRenderers}
        />
      ) : null}
    </div>
  );
}
