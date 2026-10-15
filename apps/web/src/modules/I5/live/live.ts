import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import type {
  CapabilityMap,
  PortCallOptions,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, RpcSessionPort } from "@omp-app/contracts";
import {
  asVoiceFailure,
  finalizeVoiceTranscript,
  I5_LIVE_CAPABILITY,
  type LiveMuteArgs,
  type LiveStartArgs,
  type LiveState,
  LiveStateSchema,
  type LiveTranscript,
  type VoiceSessionPort,
} from "../contract";

export interface LiveVoiceAdapter extends VoiceSessionPort {
  dispose(): Promise<void>;
  onFailure(listener: (error: AppFailure) => void): () => void;
}

export interface LiveVoiceAdapterOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities?: CapabilityMap;
  readonly sessionIdFactory?: () => string;
  readonly levelIntervalMs?: number;
}

const EMPTY_STATE: LiveState = {
  sessionId: null,
  voice: null,
  phase: "idle",
  muted: false,
  levels: { input: 0, output: 0 },
  transcripts: [],
  error: null,
  connected: false,
};

/** The phases in which omp holds a live session that only live_stop ends (issue 1280). */
const OMP_SESSION_PHASES: ReadonlySet<LiveState["phase"]> = new Set([
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
]);

function isLiveFrame(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function unavailable(message: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message,
    retryable: false,
    capability: I5_LIVE_CAPABILITY,
  });
}

export function createLiveVoiceAdapter(options: LiveVoiceAdapterOptions): LiveVoiceAdapter {
  const listeners = new Set<(state: LiveState) => void>();
  const transcriptListeners = new Set<(message: ThreadMessageLike) => void>();
  const failureListeners = new Set<(error: AppFailure) => void>();
  const sessionIdFactory = options.sessionIdFactory ?? (() => `live-${crypto.randomUUID()}`);
  const levelIntervalMs = options.levelIntervalMs ?? 100;
  let state = EMPTY_STATE;
  const capabilities = options.capabilities ?? {};
  const rpc = options.client.port(RpcSessionPort);
  const rpcSend = rpc.send.bind(rpc) as RpcSessionClient["send"];
  let unsubscribeEvents: (() => void) | undefined;
  let levelTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLevels: { input: number; output: number } | undefined;
  const finalIds = new Set<string>();
  const transcripts = new Map<string, LiveTranscript>();

  const emit = (): void => {
    state = LiveStateSchema.parse({ ...state, transcripts: [...transcripts.values()] });
    for (const listener of [...listeners]) listener(state);
  };
  const fail = (error: unknown, fallback: string): AppFailure => {
    const mapped = asVoiceFailure(error, fallback);
    state = LiveStateSchema.parse({ ...state, phase: "error", error: mapped.appError.message });
    emit();
    for (const listener of [...failureListeners]) listener(mapped);
    return mapped;
  };
  const requireLive = (): void => {
    if (capabilities[I5_LIVE_CAPABILITY]?.state !== "available") {
      throw unavailable("Live voice is unavailable for this session");
    }
  };
  const scheduleLevels = (levels: { input: number; output: number }): void => {
    pendingLevels = levels;
    if (levelTimer !== undefined) return;
    levelTimer = setTimeout(() => {
      levelTimer = undefined;
      if (!pendingLevels) return;
      const next = pendingLevels;
      pendingLevels = undefined;
      state = LiveStateSchema.parse({ ...state, levels: next });
      emit();
    }, levelIntervalMs);
  };
  const handleNotification = (frame: Record<string, unknown>): void => {
    if (frame.type === "live_phase" && typeof frame.phase === "string") {
      state = LiveStateSchema.parse({ ...state, phase: frame.phase, connected: true, error: null });
      emit();
      return;
    }
    if (
      frame.type === "live_levels" &&
      typeof frame.input === "number" &&
      typeof frame.output === "number"
    ) {
      scheduleLevels({
        input: Math.max(0, Math.min(1, frame.input)),
        output: Math.max(0, Math.min(1, frame.output)),
      });
      return;
    }
    if (
      frame.type === "live_transcript" &&
      (frame.role === "user" || frame.role === "assistant") &&
      typeof frame.turn === "number" &&
      typeof frame.text === "string" &&
      typeof frame.final === "boolean" &&
      state.sessionId
    ) {
      const transcript: LiveTranscript = {
        sessionId: state.sessionId,
        role: frame.role,
        turn: frame.turn,
        text: frame.text,
        final: frame.final,
      };
      const id = `${transcript.role}:${transcript.turn}`;
      transcripts.set(id, transcript);
      emit();
      if (transcript.final && !finalIds.has(id)) {
        finalIds.add(id);
        const message = finalizeVoiceTranscript(transcript);
        if (message) for (const listener of [...transcriptListeners]) listener(message);
      }
      return;
    }
    if (frame.type === "live_end") {
      if (typeof frame.error === "string" && frame.error.length > 0) {
        fail(
          new AppFailure({ code: "omp_error", message: frame.error, retryable: true }),
          "The live voice session ended with an error",
        );
      } else {
        state = LiveStateSchema.parse({ ...state, phase: "ended", connected: false });
        emit();
      }
    }
  };
  const subscribe = async (): Promise<void> => {
    const subscription = await options.client.subscribe(RpcSessionPort, "event", {
      scope: options.threadId,
    });
    unsubscribeEvents = subscription.onEvent((payload: RpcSessionEvent) => {
      if (payload.kind !== "notification" || !isLiveFrame(payload.frame)) return;
      handleNotification(payload.frame);
    });
  };
  const start = async (args: LiveStartArgs = {}, callOptions?: PortCallOptions) => {
    requireLive();
    // omp keeps a session until live_stop ends it, and a page that reloaded or was left leaves one behind: end it first.
    // With no session omp does nothing, and a failure here is left for the start itself to report.
    await rpcSend({ threadId: options.threadId, command: { type: "live_stop" } }).catch(
      () => undefined,
    );
    if (unsubscribeEvents === undefined) await subscribe();
    const sessionId = state.sessionId ?? sessionIdFactory();
    state = LiveStateSchema.parse({
      ...state,
      sessionId,
      phase: "connecting",
      connected: true,
      error: null,
    });
    emit();
    try {
      const result = await rpcSend(
        { threadId: options.threadId, command: { type: "live_start", ...args } },
        callOptions,
      );
      state = LiveStateSchema.parse({
        ...state,
        voice: result.voice,
        phase: "connecting",
        connected: true,
      });
      emit();
      return result;
    } catch (error) {
      throw fail(error, "Starting live voice failed");
    }
  };
  const stop = async (callOptions?: PortCallOptions): Promise<void> => {
    requireLive();
    state = LiveStateSchema.parse({ ...state, phase: "stopping" });
    emit();
    try {
      await rpcSend({ threadId: options.threadId, command: { type: "live_stop" } }, callOptions);
    } catch (error) {
      throw fail(error, "Stopping live voice failed");
    }
  };
  const mute = async (args: LiveMuteArgs = {}, callOptions?: PortCallOptions) => {
    requireLive();
    try {
      const result = await rpcSend(
        { threadId: options.threadId, command: { type: "live_mute", ...args } },
        callOptions,
      );
      state = LiveStateSchema.parse({
        ...state,
        muted: result.muted,
        phase: result.muted ? "muted" : "listening",
      });
      emit();
      return result;
    } catch (error) {
      throw fail(error, "Changing live voice mute failed");
    }
  };
  const dispose = async (): Promise<void> => {
    // Leaving the chat ends the session omp holds, and its microphone with it. The page is going, so a failed stop is not shown.
    if (OMP_SESSION_PHASES.has(state.phase)) {
      await rpcSend({ threadId: options.threadId, command: { type: "live_stop" } }).catch(
        () => undefined,
      );
    }
    if (levelTimer !== undefined) clearTimeout(levelTimer);
    levelTimer = undefined;
    pendingLevels = undefined;
    if (unsubscribeEvents) await unsubscribeEvents();
    unsubscribeEvents = undefined;
    listeners.clear();
    transcriptListeners.clear();
    failureListeners.clear();
  };
  return {
    getSnapshot: () => state,
    getCapabilities: () => capabilities,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    mute,
    onFinalTranscript(listener) {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    onFailure(listener) {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    dispose,
  };
}
