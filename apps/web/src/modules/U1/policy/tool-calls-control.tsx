import { useAuiState } from "@assistant-ui/react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranscriptDisplayPolicy } from "./policy";

/**
 * Opens every tool call in this chat, or collapses them all: the action Mod+O runs, so the two agree. It shows only
 * while the chat has a tool call, so a chat with none has nothing to say about tool calls. It sits in the chat's
 * header: on a narrow screen it is an icon (its name stays the same), so the title and the header stay on one line.
 */
export function ToolCallsControl() {
  const { expandTools, toggleExpandTools } = useTranscriptDisplayPolicy();
  const hasToolCalls = useAuiState((state) =>
    state.thread.messages.some((message) =>
      message.content.some((part) => part.type === "tool-call"),
    ),
  );
  if (!hasToolCalls) return null;
  const label = expandTools ? "Collapse all tool calls" : "Expand all tool calls";
  const Icon = expandTools ? ChevronsDownUpIcon : ChevronsUpDownIcon;
  return (
    <Button
      aria-label={label}
      className="text-muted-foreground hover:text-foreground rounded-control h-7 shrink-0 px-2 text-xs font-normal transition-colors"
      data-slot="u1-tool-calls-toggle"
      onClick={toggleExpandTools}
      size="sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" className="size-4 md:hidden" />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}
