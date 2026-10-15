import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import type { LiveState } from "../contract";
import { createLiveVoiceAdapter } from "./live";

/** A finished live turn as the chat admits it: the fields omp sent in the turn's final `live_transcript` frame. */
export interface FinishedVoiceTurn {
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly turn: number;
  readonly text: string;
}

export interface LiveVoiceSessionOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  /** Admits a finished turn into the chat, through R0. */
  readonly admitTurn: (turn: FinishedVoiceTurn) => void;
}

/** One chat's live voice: the adapter's state and the start, stop and mute actions. */
export interface LiveVoiceSession {
  getSnapshot(): LiveState;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  close(): Promise<void>;
}

/** The ids and text of a final voice message, read back from the adapter's `metadata.custom`. */
function finishedTurnOf(message: ThreadMessageLike): FinishedVoiceTurn | undefined {
  const custom = (message.metadata as { readonly custom?: Record<string, unknown> } | undefined)
    ?.custom;
  const part = Array.isArray(message.content) ? message.content[0] : undefined;
  if (custom === undefined || part === undefined || part.type !== "text") return undefined;
  const { voiceSessionId, voiceRole, voiceTurn } = custom;
  if (
    typeof voiceSessionId !== "string" ||
    (voiceRole !== "user" && voiceRole !== "assistant") ||
    typeof voiceTurn !== "number"
  ) {
    return undefined;
  }
  return { sessionId: voiceSessionId, role: voiceRole, turn: voiceTurn, text: part.text };
}

export function createLiveVoiceSession(options: LiveVoiceSessionOptions): LiveVoiceSession {
  const adapter = createLiveVoiceAdapter({
    client: options.client,
    threadId: options.threadId,
    capabilities: options.capabilities,
  });
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  // An action the adapter refused before it could record the failure (no live capability, say) is kept here.
  let actionError: string | null = null;
  let view: LiveState | undefined;
  let viewFor: LiveState | undefined;
  let viewError: string | null = null;

  const unsubscribeAdapter = adapter.subscribe(notify);
  const unadmit = adapter.onFinalTranscript((message) => {
    const turn = finishedTurnOf(message);
    if (turn !== undefined) options.admitTurn(turn);
  });

  const getSnapshot = (): LiveState => {
    const state = adapter.getSnapshot();
    if (actionError === null || state.error !== null) return state;
    // The same object until either part changes, so a React store reads a stable snapshot.
    if (view === undefined || viewFor !== state || viewError !== actionError) {
      view = { ...state, error: actionError };
      viewFor = state;
      viewError = actionError;
    }
    return view;
  };

  const act = async (run: () => Promise<unknown>): Promise<void> => {
    actionError = null;
    try {
      await run();
    } catch (error) {
      if (adapter.getSnapshot().error === null) {
        actionError = error instanceof Error ? error.message : "Live voice failed.";
      }
      notify();
    }
  };

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => act(() => adapter.start()),
    stop: () => act(() => adapter.stop()),
    setMuted: (muted) => act(() => adapter.mute({ muted })),
    async close() {
      unadmit();
      unsubscribeAdapter();
      listeners.clear();
      await adapter.dispose();
    },
  };
}
