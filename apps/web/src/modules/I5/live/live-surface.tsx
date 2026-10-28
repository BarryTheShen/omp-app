import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Surface } from "@/layout";
import { I5_LIVE_CAPABILITY, type LiveState } from "../contract";
import {
  createLiveVoiceSession,
  type FinishedVoiceTurn,
  type LiveVoiceSession,
} from "./live-session";
import { LiveStatusPanel, LiveVoiceControl } from "./live-view";

const IDLE_STATE: LiveState = {
  sessionId: null,
  voice: null,
  phase: "idle",
  muted: false,
  levels: { input: 0, output: 0 },
  transcripts: [],
  error: null,
  connected: false,
};

interface LiveVoiceSurfacesOptions {
  readonly client: AppClient | undefined;
  readonly threadId: ThreadId | undefined;
  readonly capabilities: CapabilityMap;
  /** Admits a finished turn into the open chat, through R0; a turn with no chat open is dropped. */
  readonly admitTurn: (turn: FinishedVoiceTurn) => void;
}

/**
 * The layout's live voice surface, in the thread footer above the composer: the icon control, and above it, while live,
 * the phase words, the levels and the lines still being spoken. A session belongs to one chat and is remade when the
 * chat or the live capability's state changes, because the adapter reads that state once, when it is made.
 */
export function useLiveVoiceSurfaces(options: LiveVoiceSurfacesOptions): {
  readonly liveVoice: Surface;
} {
  const { client, threadId } = options;
  const liveCapability = options.capabilities[I5_LIVE_CAPABILITY];
  const liveState = liveCapability?.state;
  const unavailableReason =
    liveState === "available"
      ? undefined
      : (liveCapability?.detail ?? "Live voice is not available in this omp version.");
  const admitRef = useRef(options.admitTurn);
  useEffect(() => {
    admitRef.current = options.admitTurn;
  });

  const [session, setSession] = useState<LiveVoiceSession | null>(null);
  useEffect(() => {
    if (client === undefined || threadId === undefined) {
      setSession(null);
      return undefined;
    }
    const created = createLiveVoiceSession({
      client,
      threadId,
      // The adapter reads only the live capability's state, so the session carries just that.
      capabilities:
        liveState === undefined
          ? {}
          : { [I5_LIVE_CAPABILITY]: { state: liveState, via: "omp" as const } },
      admitTurn: (turn) => admitRef.current(turn),
    });
    setSession(created);
    return () => {
      void created.close();
    };
  }, [client, threadId, liveState]);

  const snapshot = useSyncExternalStore(
    (listener) => session?.subscribe(listener) ?? (() => undefined),
    () => session?.getSnapshot() ?? IDLE_STATE,
    () => IDLE_STATE,
  );

  return {
    liveVoice: {
      title: "Live voice",
      render: () =>
        session === null ? null : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-(--space-xs)">
            <LiveStatusPanel state={snapshot} />
            <LiveVoiceControl
              state={snapshot}
              unavailableReason={unavailableReason}
              onStart={() => void session.start()}
              onStop={() => void session.stop()}
              onToggleMute={() => void session.setMuted(!snapshot.muted)}
            />
          </div>
        ),
    },
  };
}
