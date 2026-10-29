import { Bot } from "lucide-react";
import type { ReactNode } from "react";

/** How many subagents the chat has, and how many run: "2 agents running", "1 of 3 agents running", "3 agents". */
export function agentsSaid(running: number, total: number): string {
  const agents = total === 1 ? "agent" : "agents";
  if (running === 0) return `${total} ${agents}`;
  return running === total ? `${total} ${agents} running` : `${running} of ${total} agents running`;
}

/** Above the message box while the chat has subagents: opens the Agent Hub. */
export function AgentsPill({
  running,
  total,
  onOpen,
}: {
  readonly running: number;
  readonly total: number;
  readonly onOpen: () => void;
}): ReactNode {
  if (total === 0) return null;
  return (
    <div className="flex px-1 pb-2">
      <button
        type="button"
        className="flex h-6 items-center gap-1.5 rounded-full border border-l2 px-2.5 text-xs text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring"
        aria-keyshortcuts="Alt+A"
        onClick={onOpen}
      >
        {running > 0 ? (
          <span className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden />
        ) : (
          <Bot className="size-3.5" aria-hidden />
        )}
        {agentsSaid(running, total)}
      </button>
    </div>
  );
}
