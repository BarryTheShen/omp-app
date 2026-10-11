import { ThreadPrimitive, useThreadViewport } from "@assistant-ui/react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { AgentStatus, FocusedAgentRuntime } from "@/modules/P1/contract";
import { ScrollFollowControls, useThreadScrollController } from "@/modules/U1/scroll";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import { toReadonlyThreadMessages } from "./messages";
import { ReadOnlyThread } from "./read-only-thread";
import { SteerEditor } from "./steer-editor";
import { AgentTranscriptBody } from "./transcript-body";
import { useAgentTranscript } from "./use-agent-transcript";
import { useSteerEditor } from "./use-steer-editor";

const STATUS_LABEL: Record<AgentStatus, string> = {
  pending: "Waiting to start",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  aborted: "Cancelled",
  stopped: "Stopped",
};

export interface FocusedAgentTranscriptProps {
  /** The focused worker. Its steer refuses anything that is not running. */
  readonly runtime: FocusedAgentRuntime;
  readonly toolRenderers?: ToolRendererMap;
  /** Escape with nothing typed: leave focus. */
  readonly onExit?: () => void;
  /** Left, Left with nothing typed: return toward the Hub. */
  readonly onBack?: () => void;
}

interface FollowFooterProps {
  readonly onAtBottomChange: (isAtBottom: boolean) => void;
  readonly onFollowLatest: () => void;
}

/**
 * The "Jump to latest" row. It is mounted only while the reader is away from the newest message, so an
 * idle transcript has no empty band above the editor. The library's viewport decides when that is, and
 * the scroll controller is told the same answer.
 */
function FollowFooter({ onAtBottomChange, onFollowLatest }: FollowFooterProps) {
  const atBottom = useThreadViewport((state) => state.isAtBottom);
  useEffect(() => {
    onAtBottomChange(atBottom);
  }, [atBottom, onAtBottomChange]);
  if (atBottom) return null;
  return (
    <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10 mt-auto flex min-h-8 shrink-0 items-center justify-end border-t border-border bg-background px-4">
      <ScrollFollowControls onAtBottomChange={onAtBottomChange} onFollowLatest={onFollowLatest} />
    </ThreadPrimitive.ViewportFooter>
  );
}

/**
 * A running or finished worker's transcript, read-only, with one steer editor under it. The transcript
 * is assistant-ui's read-only thread: its viewport follows the newest message while the reader is at
 * the bottom, and U1's follow control appears when they scroll away. Rows come from U3's nested
 * composition, which has no edit, branch, reload or answer control.
 */
export function FocusedAgentTranscript({
  runtime,
  toolRenderers,
  onExit,
  onBack,
}: FocusedAgentTranscriptProps) {
  const transcript = useAgentTranscript(runtime);
  const editor = useSteerEditor({ runtime, onExit, onBack });
  const scrollRoot = useRef<HTMLDivElement | null>(null);
  const scroll = useThreadScrollController(scrollRoot);
  const threadMessages = useMemo(
    () => toReadonlyThreadMessages(transcript.messages),
    [transcript.messages],
  );
  // A worker is named by its description, else its id. Its agent type ("task") says nothing about it.
  const title = runtime.agent.description?.trim() || runtime.agent.id;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && onExit !== undefined) onExit();
  };

  return (
    <section
      aria-label={`Transcript of ${title}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="p1-focused-transcript"
      onKeyDown={handleKeyDown}
    >
      <header className="border-border flex min-w-0 items-center justify-between gap-3 border-b px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <p className="text-muted-foreground text-xs" data-slot="p1-focused-status">
            {runtime.agent.status === "running"
              ? "Running"
              : `${STATUS_LABEL[runtime.agent.status]} · read-only`}
          </p>
        </div>
        {onBack !== undefined ? (
          <Button onClick={onBack} size="sm" type="button" variant="outline">
            Back
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col" ref={scrollRoot}>
        <ReadOnlyThread messages={threadMessages}>
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport
              autoScroll
              aria-label="Worker messages"
              className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
              data-slot="u1-thread-viewport"
              role="region"
              tabIndex={0}
              turnAnchor="bottom"
            >
              <AgentTranscriptBody
                depth={0}
                taskName={title}
                toolRenderers={toolRenderers}
                transcript={transcript}
              />
              <FollowFooter
                onAtBottomChange={scroll.onAtBottomChange}
                onFollowLatest={scroll.followLatest}
              />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </ReadOnlyThread>
      </div>
      <SteerEditor
        canSend={editor.canSend}
        failure={editor.failure}
        onKey={editor.onKey}
        onSend={editor.onSend}
        onTextChange={editor.onTextChange}
        sending={editor.sending}
        text={editor.text}
        unavailable={editor.unavailable}
      />
    </section>
  );
}
