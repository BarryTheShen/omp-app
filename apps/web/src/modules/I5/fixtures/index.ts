import { ConfigListResult, type Revision } from "@omp-app/contracts";
import type { LiveEvent } from "@omp-app/contracts/chat-host";
import { LiveStateSchema, LiveTranscriptSchema } from "../contract";

/**
 * omp's live voice events as the chat host passes them on (`packages/contracts/src/chat-host/live.ts`): a session that
 * connects, listens, hears a sentence and ends with omp's error. The values are the fixture's own.
 */
export const LIVE_EVENTS_FIXTURE: readonly LiveEvent[] = [
  { type: "live_phase", phase: "connecting" },
  { type: "live_phase", phase: "listening" },
  { type: "live_levels", input: 0.25, output: 0.1 },
  {
    type: "live_transcript",
    role: "user",
    turn: 0,
    text: "Check the parser.",
    final: false,
  },
  {
    type: "live_transcript",
    role: "user",
    turn: 0,
    text: "Check the parser before merging.",
    final: true,
  },
  { type: "live_end", error: "provider stopped" },
];
export const LIVE_FINAL_TRANSCRIPT = LiveTranscriptSchema.parse({
  sessionId: "live-fixture",
  role: "user",
  turn: 0,
  text: "Check the parser before merging.",
  final: true,
});

export const LIVE_STATE_FIXTURE = LiveStateSchema.parse({
  sessionId: "live-fixture",
  voice: "arbor",
  phase: "listening",
  muted: false,
  levels: { input: 0.25, output: 0.1 },
  transcripts: [LIVE_FINAL_TRANSCRIPT],
  error: null,
  connected: true,
});

/** ConfigStore entries use the A1 schema; the credential has status only, never its secret value. */
export const CONFIG_STORE_FIXTURE = ConfigListResult.parse({
  entries: [
    { key: "live.voice", secret: false, value: "arbor", source: "default", overrides: [] },
    { key: "stt.enabled", secret: false, value: true, source: "project", overrides: ["default"] },
    { key: "searxng.token", secret: true, isSet: true, source: "env", overrides: ["default"] },
  ],
  revision: "i5-config-7" as Revision,
});

/**
 * The settings omp v18.12.6 shows in the Speech group of its interaction tab and the Services group of its providers
 * tab, that is the registrations whose `ui` names those groups, in `stt/settings.ts`, `live/settings.ts`,
 * `tts/settings.ts`, `web/settings.ts` and `session/settings.ts` (all under `packages/coding-agent/src/`; the same
 * keys as at v18.8.9 once the two Codex Code Mode settings omp removed in 18.10.4 are left out). omp registers
 * `stt.language` without a `ui`, so it is not listed.
 */
export const OMP_V18_12_6_UI_SETTING_KEYS: readonly string[] = [
  "stt.enabled",
  "stt.submitTrigger",
  "live.voice",
  "tts.localVoice",
  "tts.localSpeed",
  "speech.enabled",
  "speech.mode",
  "speech.enhanced",
  "speech.voice",
  "speech.speed",
  "providers.maxInFlightRequests",
  "providers.ollama-cloud.maxConcurrency",
  "providers.webSearchTimeoutSeconds",
  "providers.antigravityEndpoint",
  "providers.fetch",
  "codexResets.autoRedeem",
  "codexResets.minBlockedMinutes",
  "codexResets.keepCredits",
  "codexResets.salvageHorizonHours",
  "claudeResets.autoRedeem",
  "claudeResets.minBlockedMinutes",
  "claudeResets.keepCredits",
  "claudeResets.salvageHorizonHours",
  "exa.enabled",
  "exa.searchDelayMs",
  "searxng.endpoint",
];
