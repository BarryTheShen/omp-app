import type { ToolCallId } from "@omp-app/contracts";
import type { FocusedAgentRuntime } from "@/modules/P1/contract";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import { NestedWorkerControls } from "./nested-controls";
import { AgentTranscriptBody } from "./transcript-body";
import { useAgentTranscript } from "./use-agent-transcript";

export interface NestedAgentTranscriptProps {
  /** The worker's runtime, from `createFocusedAgentRuntime`: its reads, live frames, cancel and steer. */
  readonly source: FocusedAgentRuntime;
  /** The nesting level of the task card that shows this transcript. */
  readonly depth?: number;
  /** The tool call that started the worker; U3 uses it to detect a loop back to the same task. */
  readonly parentTaskId?: ToolCallId;
  readonly taskName?: string;
  readonly toolRenderers?: ToolRendererMap;
  /** Puts the cancel control and message box under the messages: for a worker that another worker started. */
  readonly controls?: boolean;
}

/**
 * A worker's transcript for a task card. It tails the worker by byte cursor while it is shown and renders its
 * messages through U3's read-only composition. With `controls`, the same cancel control and message box as the
 * Agent Hub's focused view sit under the messages, so a running worker can be stopped or steered from the card.
 */
export function NestedAgentTranscript({
  source,
  depth = 0,
  parentTaskId,
  taskName,
  toolRenderers,
  controls = false,
}: NestedAgentTranscriptProps) {
  const transcript = useAgentTranscript(source);
  return (
    <>
      <AgentTranscriptBody
        depth={depth}
        parentTaskId={parentTaskId}
        taskName={taskName}
        toolRenderers={toolRenderers}
        transcript={transcript}
      />
      {controls ? <NestedWorkerControls runtime={source} /> : null}
    </>
  );
}
