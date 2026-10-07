import type { ToolCallId } from "@omp-app/contracts";
import type { NestedTranscriptSource } from "@/modules/P1/contract";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import { AgentTranscriptBody } from "./transcript-body";
import { useAgentTranscript } from "./use-agent-transcript";

export interface NestedAgentTranscriptProps {
  /** The read-only source for one worker, from `createNestedTranscriptSource`. */
  readonly source: NestedTranscriptSource;
  /** The nesting level of the task card that shows this transcript. */
  readonly depth?: number;
  /** The tool call that started the worker; U3 uses it to detect a loop back to the same task. */
  readonly parentTaskId?: ToolCallId;
  readonly taskName?: string;
  readonly toolRenderers?: ToolRendererMap;
}

/**
 * A worker's transcript for a nested task card. It tails the worker by byte cursor while it is shown,
 * and renders through U3's read-only composition. The source has no cancel or steer, so the card
 * cannot change the worker.
 */
export function NestedAgentTranscript({
  source,
  depth = 0,
  parentTaskId,
  taskName,
  toolRenderers,
}: NestedAgentTranscriptProps) {
  const transcript = useAgentTranscript(source);
  return (
    <AgentTranscriptBody
      depth={depth}
      parentTaskId={parentTaskId}
      taskName={taskName}
      toolRenderers={toolRenderers}
      transcript={transcript}
    />
  );
}
