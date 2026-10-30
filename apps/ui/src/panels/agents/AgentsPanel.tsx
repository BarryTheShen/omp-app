import type { SubagentSnapshot } from "@omp-app/contracts/chat-host";
import { type ReactNode, useSyncExternalStore } from "react";
import { agentsSaid } from "../../agents/AgentsPill";
import type { ChatController } from "../../chat/controller";

/** Each of omp's subagent states: the word the Agent Hub shows, and the colour of its dot. */
const STATUS = {
  pending: { said: "pending", dot: "bg-accent-ink" },
  running: { said: "running", dot: "bg-accent-ink" },
  completed: { said: "completed", dot: "bg-ok" },
  failed: { said: "failed", dot: "bg-bad" },
  aborted: { said: "aborted", dot: "bg-warn" },
} as const satisfies Record<SubagentSnapshot["status"], unknown>;

const isRunning = (agent: SubagentSnapshot): boolean =>
  agent.status === "running" || agent.status === "pending";

/** What the agent does now, as omp reports it: its current tool's intent, else its last intent. */
const doingNow = (agent: SubagentSnapshot): string | undefined =>
  agent.progress?.currentToolIntent ?? agent.progress?.lastIntent;

/**
 * The focused chat's subagents, compact: each one's name, kind and state, and what it does now. A click opens the Agent
 * Hub on it, in the chat's pane, with its live transcript.
 */
export function AgentsPanel({ chat }: { readonly chat: ChatController | null }): ReactNode {
  if (chat === null) {
    return <p className="px-4 py-3 text-[0.8125rem] text-t3">Open a chat to see its agents.</p>;
  }
  return <AgentList key={chat.threadId ?? "new"} chat={chat} />;
}

function AgentList({ chat }: { readonly chat: ChatController }): ReactNode {
  const agents = useSyncExternalStore(chat.store.subscribe, () => chat.store.getSnapshot().agents);
  if (agents.length === 0) {
    return (
      <p className="px-4 py-3 text-[0.8125rem] text-t3">
        No subagents in this chat yet. omp starts them with its task tool.
      </p>
    );
  }
  const running = agents.filter(isRunning).length;
  return (
    <section aria-label="Agents" className="flex flex-col gap-1 px-2 py-3">
      <p className="px-2 pb-1 text-xs text-t3">{agentsSaid(running, agents.length)}</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const status = STATUS[agent.status];
          const now = isRunning(agent) ? doingNow(agent) : undefined;
          const name = agent.description ?? agent.id;
          return (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => chat.agentHub.open(agent.id)}
                aria-label={`${name}: ${agent.agent}, ${status.said}${now === undefined ? "" : `, ${now}`}`}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
                  <span className="min-w-0 truncate text-[0.8125rem] text-t1">{name}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 pl-3.5 text-xs text-t3">
                  <span className="shrink-0">{agent.agent}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{status.said}</span>
                  {now !== undefined && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">{now}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
