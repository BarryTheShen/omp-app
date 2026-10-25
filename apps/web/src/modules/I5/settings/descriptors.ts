import type { JsonValue } from "@omp-app/contracts";
import type {
  MapSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { numberRangeWords, settingOptions, terminalOnlyDescription } from "../../S1/settings-kit";

const HOST_CONFIG = ["host.config"] as const;

type PlainValue = JsonValue | undefined;
type Validator = (value: SettingValue) => ValidationResult;

function plain(value: SettingValue): PlainValue {
  return value.secret ? undefined : value.value;
}

function booleanValidator(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : { valid: false, code: "boolean", message: "Choose true or false." };
}

function enumValidator(values: readonly string[]): Validator {
  return (value) => {
    const candidate = plain(value);
    return typeof candidate === "string" && values.includes(candidate)
      ? { valid: true }
      : { valid: false, code: "enum", message: `Choose one of: ${values.join(", ")}.` };
  };
}

function numberValidator(minimum: number, maximum: number, integer = true): Validator {
  return (value) => {
    const candidate = plain(value);
    const valid =
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= minimum &&
      candidate <= maximum &&
      (!integer || Number.isInteger(candidate));
    return valid
      ? { valid: true }
      : {
          valid: false,
          code: "range",
          message: `Enter ${numberRangeWords(integer, minimum, maximum)}.`,
        };
  };
}

function textValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && !candidate.includes("\0")
    ? { valid: true }
    : { valid: false, code: "text", message: "Enter text without control characters." };
}

/** Every provider name maps to a positive number (the map control produces this object). */
function positiveRecordValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { valid: false, code: "record", message: "Enter request limits by provider." };
  }
  const invalid = Object.entries(candidate).some(
    ([key, limit]) =>
      key.trim().length === 0 || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0,
  );
  return invalid
    ? { valid: false, code: "record", message: "Each request limit must be a positive number." }
    : { valid: true };
}

/**
 * `providers.maxInFlightRequests`: provider name → positive concurrency limit; providers not listed
 * are unlimited, and omp rejects non-positive or non-numeric values (omp v18.12.6 docs/settings.md:960).
 */
const providerLimitsControl: MapSettingControl = {
  key: "providers.maxInFlightRequests",
  label: "Max In-Flight Requests",
  description: "Limit concurrent requests by provider. Providers not listed here remain unlimited.",
  kind: "map",
  secret: false,
  keyLabel: "Provider name",
  keyPlaceholder: "Provider name",
  value: { label: "Request limit", kind: "number", positive: true },
  addLabel: "Add provider",
  emptyLabel: "No provider-specific limits",
  validate: positiveRecordValidator,
  apply: "live",
};

function optionalUrlValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (candidate === "") return { valid: true };
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return { valid: false, code: "url", message: "Enter an HTTP(S) URL or leave it blank." };
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { valid: true }
      : { valid: false, code: "url", message: "Enter an HTTP(S) URL or leave it blank." };
  } catch {
    return { valid: false, code: "url", message: "Enter an HTTP(S) URL or leave it blank." };
  }
}
/** Choice labels `optionLabel` can't spell. */
const I5_OPTION_LABELS: Readonly<Record<string, string>> = { unset: "Not set" };

function labelFor(key: string): string {
  return (
    key
      .split(".")
      .at(-1)
      ?.replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^[a-z]/, (letter) => letter.toUpperCase()) ?? key
  );
}

function control(
  key: string,
  kind: ScalarSettingControl["kind"],
  validate: Validator,
  apply: SettingControl["apply"],
  description: string,
  options?: readonly string[],
): ScalarSettingControl {
  return {
    key,
    label: labelFor(key),
    description,
    kind,
    secret: false,
    validate,
    apply,
    ...(options === undefined ? {} : { options: settingOptions(options, I5_OPTION_LABELS) }),
  };
}

const booleanControl = (
  key: string,
  description: string,
  apply: SettingControl["apply"] = "live",
) => control(key, "boolean", booleanValidator, apply, description);

const enumControl = (
  key: string,
  values: readonly string[],
  description: string,
  apply: SettingControl["apply"] = "reload",
) => control(key, "enum", enumValidator(values), apply, description, values);

const numberControl = (
  key: string,
  minimum: number,
  maximum: number,
  description: string,
  apply: SettingControl["apply"] = "reload",
  integer = true,
) => control(key, "number", numberValidator(minimum, maximum, integer), apply, description);

const textControl = (key: string, description: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "text", textValidator, apply, description);

const urlControl = (key: string, description: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "text", optionalUrlValidator, apply, description);

const LIVE_VOICE_VALUES = [
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;

const TTS_VOICE_VALUES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_aoede",
  "af_kore",
  "af_sarah",
  "am_michael",
  "am_fenrir",
  "am_puck",
  "bf_emma",
  "bm_george",
  "bm_fable",
] as const;
/**
 * Keys and labels are copied from omp v18.12.6's registration sources:
 * - `packages/coding-agent/src/stt/settings.ts:1-45` (Speech-to-Text and submit trigger),
 * - `packages/coding-agent/src/live/settings.ts:1-20` (live.voice),
 * - `packages/coding-agent/src/tts/settings.ts:1-110` (local TTS and speech.*),
 * - `packages/coding-agent/src/session/settings.ts:160-173,912-1435` (provider services and reset policy),
 * - `packages/coding-agent/src/web/settings.ts:1-50` (Exa and SearXNG endpoint).
 *
 * omp registers `stt.language` without UI metadata; I5 places it in the Services section because the
 * frozen I5 research assigns speech language with the voice/service settings.
 */
const SETTING_LABELS: Readonly<Record<string, string>> = {
  "stt.enabled": "Speech-to-Text",
  "stt.submitTrigger": "Speech-to-Text Submit Trigger",
  "stt.language": "Speech Language",
  "live.voice": "Live Voice",
  "tts.localVoice": "Local TTS Voice",
  "tts.localSpeed": "Local TTS Speed",
  "speech.enabled": "Speech Vocalization",
  "speech.mode": "Speech Vocalization Mode",
  "speech.enhanced": "Enhanced Speech Rewriting",
  "speech.voice": "Speech Vocalization Voice",
  "speech.speed": "Speech Vocalization Speed",
  "providers.maxInFlightRequests": "Max In-Flight Requests",
  "providers.ollama-cloud.maxConcurrency": "Ollama Cloud Max Concurrency",
  "providers.webSearchTimeoutSeconds": "Web Search Timeout",
  "providers.antigravityEndpoint": "Antigravity Endpoint Mode",
  "providers.fetch": "Fetch Provider",
  "codexResets.autoRedeem": "Codex Auto-Redeem Saved Resets",
  "codexResets.minBlockedMinutes": "Codex Auto-Redeem Min Block",
  "codexResets.keepCredits": "Codex Auto-Redeem Reserve",
  "codexResets.salvageHorizonHours": "Codex Reset Salvage Horizon",
  "claudeResets.autoRedeem": "Claude Auto-Redeem Resets",
  "claudeResets.minBlockedMinutes": "Claude Auto-Redeem Min Block",
  "claudeResets.keepCredits": "Claude Auto-Redeem Reserve",
  "claudeResets.salvageHorizonHours": "Claude Reset Salvage Horizon",
  "exa.enabled": "Exa",
  "exa.searchDelayMs": "Exa Search Delay",
  "searxng.endpoint": "SearXNG Endpoint",
};

const providerServiceControls: readonly SettingControl[] = [
  control(
    "live.voice",
    "enum",
    enumValidator(LIVE_VOICE_VALUES),
    "session",
    "Codex-backed realtime voice used when a live voice session starts.",
    LIVE_VOICE_VALUES,
  ),
  textControl("stt.language", "Language used for speech recognition, for example en.", "live"),
  enumControl(
    "tts.localVoice",
    TTS_VOICE_VALUES,
    "Kokoro voice used by the local on-device text-to-speech backend.",
    "live",
  ),
  numberControl(
    "tts.localSpeed",
    0.5,
    2.5,
    "Speaking rate of the local TTS backend. 1 is normal.",
    "live",
    false,
  ),
  booleanControl(
    "speech.enabled",
    "Speak assistant output aloud through the local speech backend.",
  ),
  enumControl(
    "speech.mode",
    ["all", "assistant", "yield"],
    terminalOnlyDescription(
      "Choose whether speech reads all output, assistant messages, or only the final response.",
    ),
  ),
  booleanControl(
    "speech.enhanced",
    "Rewrite assistant output into natural spoken prose before synthesis.",
    "session",
  ),
  enumControl(
    "speech.voice",
    TTS_VOICE_VALUES,
    "Kokoro voice used for speech vocalization.",
    "live",
  ),
  numberControl(
    "speech.speed",
    0.5,
    2.5,
    "Speaking rate when reading the assistant's output aloud. 1 is normal.",
    "live",
    false,
  ),
  providerLimitsControl,
  numberControl(
    "providers.ollama-cloud.maxConcurrency",
    0,
    1_000,
    "Maximum concurrent Ollama Cloud subagent runs; zero disables its provider limit.",
    "live",
  ),
  numberControl(
    "providers.webSearchTimeoutSeconds",
    1,
    86_400,
    "Hard timeout for each web-search provider transport, in seconds.",
    "live",
  ),
  enumControl(
    "providers.antigravityEndpoint",
    ["auto", "production", "sandbox"],
    "Endpoint routing strategy for google-antigravity providers.",
    "restart",
  ),
  enumControl(
    "providers.fetch",
    ["auto", "native", "trafilatura", "lynx", "parallel", "firecrawl", "jina"],
    "Reader backend priority for the fetch/read URL tool.",
    "reload",
  ),
  enumControl(
    "codexResets.autoRedeem",
    ["unset", "yes", "no"],
    "Whether eligible saved Codex resets may be spent automatically.",
    "live",
  ),
  numberControl(
    "codexResets.minBlockedMinutes",
    0,
    43_200,
    "Minimum natural unblock delay before an automatic Codex reset is spent, in minutes.",
    "live",
  ),
  numberControl(
    "codexResets.keepCredits",
    0,
    100_000,
    "Minimum saved Codex resets to keep in reserve.",
    "live",
  ),
  numberControl(
    "codexResets.salvageHorizonHours",
    0,
    8_760,
    "Hours before expiry when a saved Codex reset may be salvaged.",
    "live",
  ),
  enumControl(
    "claudeResets.autoRedeem",
    ["unset", "yes", "no"],
    "Whether eligible Claude resets may be spent automatically.",
    "live",
  ),
  numberControl(
    "claudeResets.minBlockedMinutes",
    0,
    43_200,
    "Minimum natural unblock delay before an automatic Claude reset is spent, in minutes.",
    "live",
  ),
  numberControl(
    "claudeResets.keepCredits",
    0,
    100_000,
    "Minimum saved Claude resets to keep in reserve.",
    "live",
  ),
  numberControl(
    "claudeResets.salvageHorizonHours",
    0,
    8_760,
    "Hours before expiry when a saved Claude reset may be salvaged.",
    "live",
  ),
  booleanControl("exa.enabled", "Enable the Exa web-search provider.", "live"),
  numberControl(
    "exa.searchDelayMs",
    0,
    86_400_000,
    "Minimum delay between Exa web-search requests, in milliseconds.",
    "live",
  ),
  urlControl(
    "searxng.endpoint",
    "Base URL of a self-hosted SearXNG instance used for web search.",
    "restart",
  ),
];
const PROVIDER_SERVICE_CONTROLS: readonly SettingControl[] = providerServiceControls.map(
  (control) => ({
    ...control,
    label: SETTING_LABELS[control.key] ?? control.label,
  }),
);

function section(
  id: SettingsSectionDescriptor["id"],
  name: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return { id, section: name, title, inventory, controls, requires: [...HOST_CONFIG] };
}

export const INTERACTION_SPEECH_SECTION = section(
  "I5.interactionSpeech",
  "interaction/Speech",
  "Speech",
  ["S3.interaction-speech"],
  [
    booleanControl(
      "stt.enabled",
      terminalOnlyDescription("Enable speech-to-text input through the microphone."),
      "live",
    ),
    enumControl(
      "stt.submitTrigger",
      ["never", "release", "release-complete", "say-submit"],
      "Choose whether dictation inserts text only or submits on release/say-submit.",
      "live",
    ),
  ].map((control) => ({ ...control, label: SETTING_LABELS[control.key] ?? control.label })),
);

export const PROVIDERS_SERVICES_SECTION = section(
  "I5.providersServices",
  "providers/Services",
  "Services",
  ["S5.providers-services"],
  PROVIDER_SERVICE_CONTROLS,
);

export const I5_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  INTERACTION_SPEECH_SECTION,
  PROVIDERS_SERVICES_SECTION,
];

export const I5_SETTING_KEYS = I5_SETTINGS_SECTIONS.map((descriptor) =>
  descriptor.controls.map((control) => control.key),
);
