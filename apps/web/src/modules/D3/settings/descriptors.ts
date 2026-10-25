import type { CapabilityKey, JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { settingOptions } from "../../S1/settings-kit";

export type ProviderControlEvidence = {
  readonly defaultValue: JsonValue;
  readonly registrySource: string;
  readonly boundarySource: string;
};

export type ProviderSettingControl = ScalarSettingControl & ProviderControlEvidence;
export type ProviderSettingsSectionDescriptor = Omit<SettingsSectionDescriptor, "controls"> & {
  readonly controls: readonly ProviderSettingControl[];
};

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function invalid(code: string, message: string): ValidationResult {
  return { valid: false, code, message };
}

function booleanValue(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : invalid("boolean", "Choose true or false.");
}

function enumValue(values: readonly string[]) {
  return (value: SettingValue): ValidationResult => {
    const candidate = plain(value);
    return typeof candidate === "string" && values.includes(candidate)
      ? { valid: true }
      : invalid("choice", "Choose one of the available options.");
  };
}

function durationValue(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? { valid: true }
    : invalid("duration", "Enter a number of seconds.");
}

function previewValue(key: string): ScalarSettingControl["preview"] {
  return (value) => (value.secret ? null : { key, value: value.value });
}

function control(
  key: string,
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  options: readonly SettingOption[] | undefined,
  description: string,
  apply: ScalarSettingControl["apply"],
  evidence: ProviderControlEvidence,
): ProviderSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    validate,
    apply,
    description,
    ...evidence,
    ...(options === undefined ? {} : { options }),
    preview: previewValue(key),
  };
}

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly ProviderSettingControl[],
): ProviderSettingsSectionDescriptor {
  return { id, section: sectionName, title, inventory, controls, requires: [...HOST_CONFIG] };
}

const fireworksTier = ["standard", "priority"] as const;
const tinyDevice = [
  "default",
  "gpu",
  "cpu",
  "mlx",
  "metal",
  "webgpu",
  "cuda",
  "dml",
  "coreml",
  "auto",
  "wasm",
  "webnn",
  "webnn-gpu",
  "webnn-cpu",
  "webnn-npu",
] as const;
const tinyDtype = [
  "default",
  "q4",
  "q4f16",
  "q8",
  "fp16",
  "fp32",
  "int8",
  "uint8",
  "bnb4",
  "q2",
  "q2f16",
  "q1",
  "q1f16",
  "auto",
] as const;
const kimiFormat = ["auto", "openai", "anthropic"] as const;
const openaiWebsockets = ["auto", "off", "on"] as const;
const cacheRetention = ["auto", "short", "long", "none"] as const;
const cacheWarming = ["off", "streaming", "idle"] as const;
const openrouterVariant = ["default", "nitro", "floor", "online", "exacto"] as const;
const appendOnlyContext = ["auto", "on", "off"] as const;

const timeoutOptions: readonly SettingOption[] = [
  { value: -1, label: "Automatic" },
  { value: 0, label: "Off" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
];

function evidence(
  defaultValue: JsonValue,
  registrySource: string,
  boundarySource: string,
): ProviderControlEvidence {
  return { defaultValue, registrySource, boundarySource };
}

const enumControl = (
  key: string,
  label: string,
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
  description: string,
  apply: ScalarSettingControl["apply"],
  proof: ProviderControlEvidence,
): ProviderSettingControl =>
  control(
    key,
    label,
    "enum",
    enumValue(values),
    settingOptions(values, labels),
    description,
    apply,
    proof,
  );

const booleanControl = (
  key: string,
  label: string,
  description: string,
  apply: ScalarSettingControl["apply"],
  proof: ProviderControlEvidence,
): ProviderSettingControl =>
  control(key, label, "boolean", booleanValue, undefined, description, apply, proof);

const durationControl = (
  key: string,
  label: string,
  description: string,
  registrySource: string,
  boundarySource: string,
): ProviderSettingControl =>
  control(
    key,
    label,
    "number",
    durationValue,
    timeoutOptions,
    description,
    "live",
    evidence(-1, registrySource, boundarySource),
  );

export const PROVIDER_SETTINGS_SECTIONS: readonly ProviderSettingsSectionDescriptor[] = [
  section(
    "D3.providerFireworks",
    "providers/Fireworks",
    "Fireworks",
    ["S5.providers-fireworks"],
    [
      enumControl(
        "providers.fireworksTier",
        "Fireworks tier",
        fireworksTier,
        { standard: "Standard", priority: "Priority" },
        "Fireworks serving tier. Priority costs more but has higher reliability during peak traffic; Standard uses the default path. Fast models use their own fast path.",
        "live",
        evidence("standard", "session/settings.ts:946-967", "session/model-controls.ts:743"),
      ),
    ],
  ),
  section(
    "D3.providerTinyModel",
    "providers/Tiny Model",
    "Tiny model",
    ["S5.providers-tiny-model"],
    [
      enumControl(
        "providers.tinyModelDevice",
        "Tiny model device",
        tinyDevice,
        {
          default: "Default",
          gpu: "GPU",
          cpu: "CPU",
          mlx: "MLX on Apple silicon",
          metal: "Metal alias",
          webgpu: "WebGPU",
          cuda: "CUDA",
          dml: "DirectML",
          coreml: "CoreML",
          auto: "Automatic",
          wasm: "WebAssembly",
          webnn: "WebNN",
          "webnn-gpu": "WebNN GPU",
          "webnn-cpu": "WebNN CPU",
          "webnn-npu": "WebNN NPU",
        },
        "Inference backend for local tiny models. Default uses CPU-only ONNX; MLX runs on Apple silicon. Environment settings can override this choice.",
        "live",
        evidence(
          "default",
          "session/settings.ts:968-986; tiny/device.ts:78-114",
          "tiny/title-client.ts:142-154,716-720",
        ),
      ),
      enumControl(
        "providers.tinyModelDtype",
        "Tiny model precision",
        tinyDtype,
        {
          default: "Default",
          q4: "4-bit weights",
          q4f16: "4-bit weights with 16-bit activations",
          q8: "8-bit weights",
          fp16: "16-bit float",
          fp32: "32-bit float",
          int8: "8-bit integer",
          uint8: "Unsigned 8-bit integer",
          bnb4: "4-bit bitsandbytes",
          q2: "2-bit weights",
          q2f16: "2-bit weights with 16-bit activations",
          q1: "1-bit weights",
          q1f16: "1-bit weights with 16-bit activations",
          auto: "Automatic",
        },
        "ONNX precision for local tiny models. Default uses each model's shipped precision; higher precision uses more memory. Environment settings can override this choice.",
        "live",
        evidence(
          "default",
          "session/settings.ts:987-1005; tiny/dtype.ts:53-90",
          "tiny/title-client.ts:142-154,716-720",
        ),
      ),
    ],
  ),
  section(
    "D3.providerProtocol",
    "providers/Protocol",
    "Protocol",
    ["S5.providers-protocol"],
    [
      enumControl(
        "providers.kimiApiFormat",
        "Kimi API format",
        kimiFormat,
        { auto: "Auto", openai: "OpenAI", anthropic: "Anthropic" },
        "Kimi Code API format. Auto follows live model metadata.",
        "live",
        evidence("auto", "session/settings.ts:1052-1068", "sdk.ts:4278-4290"),
      ),
      enumControl(
        "providers.openaiWebsockets",
        "OpenAI WebSockets",
        openaiWebsockets,
        { auto: "Auto", off: "Off", on: "On" },
        "WebSocket policy for OpenAI Codex models. Auto follows model defaults; On forces WebSockets; Off disables them.",
        "live",
        evidence("auto", "session/settings.ts:1070-1086", "sdk.ts:4287"),
      ),
      booleanControl(
        "providers.openaiLiveSteering",
        "OpenAI live steering",
        "Send text you type while a GPT-6 response streams into that response over the Codex WebSocket instead of waiting for the next tool boundary.",
        "live",
        evidence(true, "session/settings.ts:1088-1100", "session/settings-stream-fn.ts:166"),
      ),
      booleanControl(
        "providers.muse-code.storeResponses",
        "Muse Code stored responses",
        "When using Muse Code, store responses on Meta's servers so a disconnected turn can resume instead of running again. Prompts and outputs are stored on Meta. Environment settings can override this choice.",
        "live",
        evidence(
          false,
          "session/settings.ts:1128-1139",
          "session/settings.ts:1143; session/settings-stream-fn.ts:136-138",
        ),
      ),
      enumControl(
        "providers.cacheRetention",
        "Prompt cache retention",
        cacheRetention,
        { auto: "Auto", short: "Short", long: "Long", none: "Off" },
        "Prompt-cache retention for supported providers. Auto follows provider defaults, Short is 5 minutes, Long is a longer lifetime where supported (1 hour on Anthropic and Bedrock, 12 hours on OpenAI GPT-5.6 and later Responses), and Off disables caching. Environment settings still apply.",
        "live",
        evidence("auto", "session/settings.ts:1146-1177", "session/settings-stream-fn.ts:103-106"),
      ),
      enumControl(
        "providers.cacheWarming",
        "Cache warming",
        cacheWarming,
        { off: "Off", streaming: "Streaming", idle: "Idle" },
        "Send a one-token request shortly before a prompt cache expires. Streaming protects long tool runs; Idle also refreshes between runs when expected savings exceed its cost.",
        "live",
        evidence(
          "idle",
          "session/settings.ts:1151-1178",
          "session/agent-session.ts:1769; sdk.ts:4300",
        ),
      ),
      enumControl(
        "providers.openrouterVariant",
        "OpenRouter routing",
        openrouterVariant,
        {
          default: "Default",
          nitro: "Nitro",
          floor: "Lowest cost",
          online: "Online",
          exacto: "Exacto",
        },
        "Default route appended to OpenRouter model IDs unless a model choice already names a route.",
        "live",
        evidence("default", "session/settings.ts:1219-1248", "session/settings-stream-fn.ts:87-90"),
      ),
      enumControl(
        "provider.appendOnlyContext",
        "Append-only context",
        appendOnlyContext,
        { auto: "Auto", on: "On", off: "Off" },
        "Keep the system prompt and tool list cached while adding new messages without rewriting earlier ones. Auto enables this for providers known to cache prefixes.",
        "live",
        evidence(
          "auto",
          "session/settings.ts:1415-1432",
          "session/agent-session.ts:2415-2416,10735-10754",
        ),
      ),
    ],
  ),
  section(
    "D3.providerTimeouts",
    "providers/Timeouts",
    "Timeouts",
    ["S5.providers-timeouts"],
    [
      durationControl(
        "providers.streamFirstEventTimeoutSeconds",
        "Stream first event timeout",
        "Seconds to wait for the first model response; negative values use provider and environment defaults, and zero disables the timeout.",
        "session/settings.ts:1179-1198",
        "session/settings-stream-fn.ts:105-106",
      ),
      durationControl(
        "providers.streamIdleTimeoutSeconds",
        "Stream idle timeout",
        "Seconds a model response may stay silent between updates; negative values use provider and environment defaults, and zero disables the timeout.",
        "session/settings.ts:1199-1218",
        "session/settings-stream-fn.ts:105-106",
      ),
    ],
  ),
  section(
    "D3.providerPrivacy",
    "providers/Privacy",
    "Privacy",
    ["S5.providers-privacy"],
    [
      booleanControl(
        "secrets.enabled",
        "Hide secrets",
        "Obfuscate configured secrets and redact credential-shaped tokens before sending requests to AI providers.",
        "live",
        evidence(false, "secrets/settings.ts:13-26", "sdk.ts:4275,4698-4705"),
      ),
      booleanControl(
        "telemetry.otlpExportEnabled",
        "OTLP telemetry export",
        "Allow omp to export traces, logs, and metrics to configured telemetry endpoints. Changes take effect after the next launch.",
        "restart",
        evidence(true, "telemetry-settings.ts:8-19", "main.ts:2227"),
      ),
    ],
  ),
];
