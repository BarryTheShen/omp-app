import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { type TaskSubagentLookup, TaskSubagentsContext } from "@/modules/T5/task";
import { createThreadAgents, type ThreadAgents, type ThreadAgentsOptions } from "./thread-agents";

interface Current {
  readonly inputs: ThreadAgentsOptions;
  readonly agents: ThreadAgents;
}

function sameInputs(a: ThreadAgentsOptions, b: ThreadAgentsOptions): boolean {
  return (
    a.threadId === b.threadId &&
    a.store === b.store &&
    a.session === b.session &&
    a.capabilities === b.capabilities
  );
}

/**
 * The open chat's subagents. The roster is made when the chat opens, and again when its inputs change,
 * and it is disposed when the chat closes or switches, so no subscription outlives its chat. The render
 * right after a switch gives `null` rather than the previous chat's roster.
 */
export function useThreadAgents(options: ThreadAgentsOptions): ThreadAgents | null {
  const { threadId, store, session, capabilities } = options;
  const [current, setCurrent] = useState<Current | null>(null);
  useEffect(() => {
    const inputs = { threadId, store, session, capabilities };
    const agents = createThreadAgents(inputs);
    setCurrent({ inputs, agents });
    return () => {
      void agents.dispose();
    };
  }, [capabilities, session, store, threadId]);
  if (current === null) return null;
  return sameInputs(current.inputs, { threadId, store, session, capabilities })
    ? current.agents
    : null;
}

/**
 * Gives the task cards in the chat their workers. A card's lookup reads the chat's roster, and the first
 * card to ask starts it (so does opening the Agents tab). The cards render again when the roster changes.
 */
export function TaskSubagentsScope({
  agents,
  children,
}: {
  readonly agents: ThreadAgents | null;
  readonly children: ReactNode;
}) {
  const subscribe = useCallback(
    (onChange: () => void) => agents?.roster.subscribe(onChange) ?? (() => undefined),
    [agents],
  );
  const getSnapshot = useCallback(() => agents?.roster.getSnapshot() ?? null, [agents]);
  // Subscribing re-renders this scope when the roster changes, and that hands the cards a new lookup.
  useSyncExternalStore(subscribe, getSnapshot);
  const lookup: TaskSubagentLookup | undefined =
    agents === null
      ? undefined
      : (parentToolCallId) => {
          // Starting is idempotent: the first card that asks starts the roster, and the rest share that start.
          void agents.start().catch(() => undefined);
          return agents.subagentsFor(parentToolCallId);
        };
  return <TaskSubagentsContext.Provider value={lookup}>{children}</TaskSubagentsContext.Provider>;
}
