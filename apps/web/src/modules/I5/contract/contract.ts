import type {
  DictationAdapter,
  SpeechSynthesisAdapter,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { CapabilityKey, CapabilityMap, Omp, PortCallOptions } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

export const I5_LIVE_CAPABILITY: CapabilityKey = "omp.live-voice";
export const I5_BROWSER_SPEECH_CAPABILITIES = {
  recognition: "client.speech-recognition" as CapabilityKey,
  synthesis: "client.speech-synthesis" as CapabilityKey,
} as const;

export const LivePhaseSchema = z.enum([
  "idle",
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "stopping",
  "ended",
  "error",
]);
export type LivePhase = z.infer<typeof LivePhaseSchema>;

export const LiveTranscriptSchema = z.strictObject({
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  turn: z.int().nonnegative(),
  text: z.string(),
  final: z.boolean(),
});
export type LiveTranscript = z.infer<typeof LiveTranscriptSchema>;

export const LiveStateSchema = z.strictObject({
  sessionId: z.string().nullable(),
  voice: z.string().nullable(),
  phase: LivePhaseSchema,
  muted: z.boolean(),
  levels: z.strictObject({ input: z.number().min(0).max(1), output: z.number().min(0).max(1) }),
  transcripts: z.array(LiveTranscriptSchema),
  error: z.string().nullable(),
  connected: z.boolean(),
});
export type LiveState = z.infer<typeof LiveStateSchema>;

export const LiveStartArgsSchema = z.strictObject({
  voice: z.string().min(1).optional(),
  instructions: z.string().optional(),
});
export type LiveStartArgs = z.infer<typeof LiveStartArgsSchema>;
export const LiveMuteArgsSchema = z.strictObject({ muted: z.boolean().optional() });
export type LiveMuteArgs = z.infer<typeof LiveMuteArgsSchema>;

export interface VoiceSessionPort {
  getSnapshot(): LiveState;
  getCapabilities(): CapabilityMap;
  subscribe(listener: (state: LiveState) => void): () => void;
  start(args?: LiveStartArgs, options?: PortCallOptions): Promise<Omp.LiveStartResult>;
  stop(options?: PortCallOptions): Promise<void>;
  mute(args?: LiveMuteArgs, options?: PortCallOptions): Promise<Omp.LiveMuteResult>;
  onFinalTranscript(listener: (message: ThreadMessageLike) => void): () => void;
}

export interface SpeechAdapter extends SpeechSynthesisAdapter {
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface DictationPort extends DictationAdapter {
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface FinalVoiceMessage extends ThreadMessageLike {
  readonly role: "user" | "assistant";
  readonly id: string;
  readonly metadata: {
    readonly modality: "voice";
    readonly custom: Record<string, unknown>;
  };
}

export function finalizeVoiceTranscript(transcript: LiveTranscript): FinalVoiceMessage | null {
  if (!transcript.final || transcript.text.length === 0) return null;
  return {
    role: transcript.role,
    id: `voice:${transcript.sessionId}:${transcript.role}:${transcript.turn}`,
    content: [{ type: "text", text: transcript.text }],
    metadata: {
      modality: "voice",
      custom: {
        voiceSessionId: transcript.sessionId,
        voiceRole: transcript.role,
        voiceTurn: transcript.turn,
      },
    },
  } as FinalVoiceMessage;
}

export function browserSpeechAvailability(): {
  readonly recognition: boolean;
  readonly synthesis: boolean;
} {
  const scope =
    typeof globalThis === "undefined"
      ? undefined
      : (globalThis as typeof globalThis & {
          SpeechRecognition?: unknown;
          webkitSpeechRecognition?: unknown;
          speechSynthesis?: unknown;
        });
  return {
    recognition:
      typeof scope?.SpeechRecognition === "function" ||
      typeof scope?.webkitSpeechRecognition === "function",
    synthesis: scope?.speechSynthesis !== undefined,
  };
}

export function asVoiceFailure(error: unknown, fallback = "The voice session failed"): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error });
}

export function unavailableVoice(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

export function liveCapabilityAvailable(capabilities: CapabilityMap): boolean {
  return capabilities[I5_LIVE_CAPABILITY]?.state === "available";
}
