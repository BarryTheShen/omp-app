import type { FocusedAgentRuntime } from "@/modules/P1/contract";
import { CancelButton, CancelNotice } from "@/modules/P1/panels/cancel-control";
import { SteerEditor } from "./steer-editor";
import { useNestedCancel } from "./use-nested-cancel";
import { useSteerEditor } from "./use-steer-editor";

/**
 * The cancel control and the message box under a nested worker's transcript: the same controls the Agent
 * Hub's focused view has. The message box is off, with its reason, while the worker is not running.
 */
export function NestedWorkerControls({ runtime }: { readonly runtime: FocusedAgentRuntime }) {
  const cancel = useNestedCancel(runtime);
  const steer = useSteerEditor({ runtime });
  return (
    <div className="flex min-w-0 flex-col" data-slot="p1-nested-controls">
      {cancel.control.state === "hidden" ? null : (
        <div className="flex min-w-0 flex-col items-start gap-2 px-4 pt-3">
          <CancelButton control={cancel.control} onCancel={cancel.cancel} title={cancel.title} />
          <CancelNotice control={cancel.control} onCancel={cancel.cancel} />
        </div>
      )}
      <SteerEditor
        canSend={steer.canSend}
        failure={steer.failure}
        label={cancel.title}
        onKey={steer.onKey}
        onSend={steer.onSend}
        onTextChange={steer.onTextChange}
        sending={steer.sending}
        text={steer.text}
        unavailable={steer.unavailable}
      />
    </div>
  );
}
