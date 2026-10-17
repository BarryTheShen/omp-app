import { ConfigListResult, type OmpWire, type Revision } from "@omp-app/contracts";
import { LiveStateSchema, LiveTranscriptSchema } from "../contract";

/**
 * Source: omp v18.8.9 `docs/rpc.md:1396-1399` and `packages/coding-agent/src/modes/rpc/rpc-types.ts:259-287`.
 */
export const LIVE_RPC_FIXTURE: readonly OmpWire.RpcNotification[] = [
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
 * The settings omp v18.8.9 shows in the Speech group of its interaction tab and the Services group of its providers
 * tab, that is the registrations whose `ui` names those groups: `group: "Speech"` at `stt/settings.ts:15,30`;
 * `group: "Services"` at `live/settings.ts:15`, `tts/settings.ts:21,34,47,60,78,92,105`, `web/settings.ts:14,26,40` and
 * `session/settings.ts:131,148,161,891,903,923,1251,1278,1300,1313,1326,1352,1374,1387,1400` (all under
 * `packages/coding-agent/src/`). omp registers `stt.language` without a `ui`, so it is not listed.
 */
export const OMP_V18_8_9_UI_SETTING_KEYS: readonly string[] = [
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
  "providers.openai-codex.codeMode",
  "providers.openai-codex.codeModeDirectTools",
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
