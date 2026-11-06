import { Info, ListChecks } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { agentsSaid } from "../agents/AgentsPill";
import { currentTask, finished } from "../todos/TodoList";
import type { ChatController } from "./controller";

type Snapshot = ReturnType<ChatController["store"]["getSnapshot"]>;

const NO_CHAT = {
  subscribe: () => () => {},
  getSnapshot: (): Snapshot | null => null,
};

/**
 * The phone's top bar opens the chat's details (#2837). While omp keeps a todo list or the chat has agents, the button
 * says how far the list got and how many agents there are, in place of ⓘ, and opens the details at Progress (at Agents
 * when there is no list): the pills that took a row of their own above the message box live here instead.
 */
export function PhoneDetailsButton({
  chat,
  onOpen,
}: {
  readonly chat: ChatController | null;
  /** Opens the chat's details at `panel`, or at the panel shown last (`null`). */
  readonly onOpen: (panel: "progress" | "agents" | null) => void;
}): ReactNode {
  const store = chat?.store ?? NO_CHAT;
  const snapshot = useSyncExternalStore<Snapshot | null>(store.subscribe, store.getSnapshot);
  const phases = snapshot?.todos ?? [];
  const tasks = phases.flatMap((phase) => phase.tasks);
  const agents = snapshot?.agents ?? [];
  const running = agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  if (tasks.length === 0 && agents.length === 0)
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 text-t2"
        aria-label="Details"
        data-tour="chat-details-button"
        onClick={() => onOpen(null)}
      >
        <Info />
      </Button>
    );
  const done = tasks.filter(finished).length;
  const now = currentTask(phases);
  const said = [
    tasks.length > 0
      ? `Todos: ${done} of ${tasks.length} done${now === null ? "" : `, now: ${now.content}`}`
      : null,
    agents.length > 0 ? agentsSaid(running, agents.length) : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  return (
    <Button
      variant="ghost"
      className="h-11 shrink-0 gap-2 px-2 text-xs text-t2 tabular-nums"
      aria-label={`${said}. Details`}
      data-tour="chat-details-button"
      onClick={() => onOpen(tasks.length > 0 ? "progress" : "agents")}
    >
      {tasks.length > 0 && (
        <span data-tour="todos" className="flex items-center gap-1">
          <ListChecks className="size-4" aria-hidden />
          {done}/{tasks.length}
        </span>
      )}
      {agents.length > 0 && (
        <span className="flex items-center gap-1">
          <span
            className={`size-1.5 rounded-full ${running > 0 ? "bg-live" : "bg-t3"}`}
            aria-hidden
          />
          {running > 0 ? running : agents.length}
        </span>
      )}
    </Button>
  );
}
