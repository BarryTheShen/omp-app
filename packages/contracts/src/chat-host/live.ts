/**
 * Live voice (SDK plan H5.2g4): omp's realtime voice session on the chat's session, as omp's RPC live bridge
 * (18.12.6 `modes/rpc/rpc-live.ts`, `rpc-mode.ts:2188-2211`).
 */
import type { LiveTranscript } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { z } from "zod";

export const LiveStartParams = z.object({
  /** One of omp's realtime voices; without it, omp's `live.voice` setting, else `sol`. */
  voice: z.string().optional(),
  /** A Handlebars template in place of omp's live instructions, rendered with `{ username, firstName }`. */
  instructions: z.string().optional(),
});
export type LiveStartParams = z.infer<typeof LiveStartParams>;

/** `muted` sets the microphone mute; without it the mute toggles. */
export const LiveMuteParams = z.object({ muted: z.boolean().optional() });
export type LiveMuteParams = z.infer<typeof LiveMuteParams>;

export interface LivePhaseEvent {
  readonly type: "live_phase";
  readonly phase: LivePhase;
}

/** Microphone and speaker levels in [0, 1]: at most one event per 100 ms, with the latest values. */
export interface LiveLevelsEvent {
  readonly type: "live_levels";
  readonly input: number;
  readonly output: number;
}

/** One realtime turn's transcript so far (`final: false`) or in full; the app joins them by `role` and `turn`. */
export type LiveTranscriptEvent = { readonly type: "live_transcript" } & Readonly<LiveTranscript>;

/** Once per live session, when it has ended; `error` says why when it failed. */
export interface LiveEndEvent {
  readonly type: "live_end";
  readonly error?: string;
}

export type LiveEvent = LivePhaseEvent | LiveLevelsEvent | LiveTranscriptEvent | LiveEndEvent;
