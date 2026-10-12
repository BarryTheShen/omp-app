import { useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { useTranscriptDisplayPolicy } from "./policy";

/**
 * Opens every tool call in this chat, or collapses them all: the action Mod+O runs, so the two agree. It shows only
 * while the chat has a tool call, so a chat with none has nothing to say about tool calls.
 */
export function ToolCallsControl() {
  const { expandTools, toggleExpandTools } = useTranscriptDisplayPolicy();
  const hasToolCalls = useAuiState((state) =>
    state.thread.messages.some((message) =>
      message.content.some((part) => part.type === "tool-call"),
    ),
  );
  if (!hasToolCalls) return null;
  return (
    <Button
      data-slot="u1-tool-calls-toggle"
      onClick={toggleExpandTools}
      size="sm"
      type="button"
      variant="outline"
    >
      {expandTools ? "Collapse all tool calls" : "Expand all tool calls"}
    </Button>
  );
}
