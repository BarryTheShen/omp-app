import { describe, expect, test } from "vitest";
import { PROVIDER_SETTINGS_SECTIONS } from "./descriptors";

const section = (name: string) => {
  const value = PROVIDER_SETTINGS_SECTIONS.find((candidate) => candidate.section === name);
  if (!value) throw new Error(`Missing provider settings section ${name}`);
  return value;
};
const OMP_PROVIDER_SETTINGS = [
  {
    key: "providers.fireworksTier",
    kind: "enum",
    defaultValue: "standard",
    options: ["standard", "priority"],
    apply: "live",
    registrySource: "session/settings.ts:946-967",
    boundarySource: "session/model-controls.ts:743",
    description:
      "Fireworks serving tier. Priority costs more but has higher reliability during peak traffic; Standard uses the default path. Fast models use their own fast path.",
  },
  {
    key: "providers.tinyModelDevice",
    kind: "enum",
    defaultValue: "default",
    options: [
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
    ],
    apply: "live",
    registrySource: "session/settings.ts:968-986; tiny/device.ts:78-114",
    boundarySource: "tiny/title-client.ts:142-154,716-720",
    description:
      "Inference backend for local tiny models. Default uses CPU-only ONNX; MLX runs on Apple silicon. Environment settings can override this choice.",
  },
  {
    key: "providers.tinyModelDtype",
    kind: "enum",
    defaultValue: "default",
    options: [
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
    ],
    apply: "live",
    registrySource: "session/settings.ts:987-1005; tiny/dtype.ts:53-90",
    boundarySource: "tiny/title-client.ts:142-154,716-720",
    description:
      "ONNX precision for local tiny models. Default uses each model's shipped precision; higher precision uses more memory. Environment settings can override this choice.",
  },
  {
    key: "providers.kimiApiFormat",
    kind: "enum",
    defaultValue: "auto",
    options: ["auto", "openai", "anthropic"],
    apply: "live",
    registrySource: "session/settings.ts:1052-1068",
    boundarySource: "sdk.ts:4278-4290",
    description: "Kimi Code API format. Auto follows live model metadata.",
  },
  {
    key: "providers.openaiWebsockets",
    kind: "enum",
    defaultValue: "auto",
    options: ["auto", "off", "on"],
    apply: "live",
    registrySource: "session/settings.ts:1070-1086",
    boundarySource: "sdk.ts:4287",
    description:
      "WebSocket policy for OpenAI Codex models. Auto follows model defaults; On forces WebSockets; Off disables them.",
  },
  {
    key: "providers.openaiLiveSteering",
    kind: "boolean",
    defaultValue: true,
    options: [],
    apply: "live",
    registrySource: "session/settings.ts:1088-1100",
    boundarySource: "session/settings-stream-fn.ts:166",
    description:
      "Send text you type while a GPT-6 response streams into that response over the Codex WebSocket instead of waiting for the next tool boundary.",
  },
  {
    key: "providers.cacheRetention",
    kind: "enum",
    defaultValue: "auto",
    options: ["auto", "short", "long", "none"],
    apply: "live",
    registrySource: "session/settings.ts:1118-1150",
    boundarySource: "session/settings-stream-fn.ts:103-106",
    description:
      "Prompt-cache retention for supported providers. Auto follows provider defaults, Short is 5 minutes, Long is 1 hour where supported, and Off disables caching. Environment settings still apply.",
  },
  {
    key: "providers.cacheWarming",
    kind: "enum",
    defaultValue: "idle",
    options: ["off", "streaming", "idle"],
    apply: "live",
    registrySource: "session/settings.ts:1151-1178",
    boundarySource: "session/agent-session.ts:1769; sdk.ts:4300",
    description:
      "Send a one-token request shortly before a prompt cache expires. Streaming protects long tool runs; Idle also refreshes between runs when expected savings exceed its cost.",
  },
  {
    key: "providers.openrouterVariant",
    kind: "enum",
    defaultValue: "default",
    options: ["default", "nitro", "floor", "online", "exacto"],
    apply: "live",
    registrySource: "session/settings.ts:1219-1248",
    boundarySource: "session/settings-stream-fn.ts:87-90",
    description:
      "Default route appended to OpenRouter model IDs unless a model choice already names a route.",
  },
  {
    key: "provider.appendOnlyContext",
    kind: "enum",
    defaultValue: "auto",
    options: ["auto", "on", "off"],
    apply: "live",
    registrySource: "session/settings.ts:1415-1432",
    boundarySource: "session/agent-session.ts:2415-2416,10735-10754",
    description:
      "Keep the system prompt and tool list cached while adding new messages without rewriting earlier ones. Auto enables this for providers known to cache prefixes.",
  },
  {
    key: "providers.streamFirstEventTimeoutSeconds",
    kind: "number",
    defaultValue: -1,
    options: [-1, 0, 300, 600, 1800],
    apply: "live",
    registrySource: "session/settings.ts:1179-1198",
    boundarySource: "session/settings-stream-fn.ts:105-106",
    description:
      "Seconds to wait for the first model response; negative values use provider and environment defaults, and zero disables the timeout.",
  },
  {
    key: "providers.streamIdleTimeoutSeconds",
    kind: "number",
    defaultValue: -1,
    options: [-1, 0, 300, 600, 1800],
    apply: "live",
    registrySource: "session/settings.ts:1199-1218",
    boundarySource: "session/settings-stream-fn.ts:105-106",
    description:
      "Seconds a model response may stay silent between updates; negative values use provider and environment defaults, and zero disables the timeout.",
  },
  {
    key: "secrets.enabled",
    kind: "boolean",
    defaultValue: false,
    options: [],
    apply: "live",
    registrySource: "secrets/settings.ts:13-26",
    boundarySource: "sdk.ts:4275,4698-4705",
    description:
      "Obfuscate configured secrets and redact credential-shaped tokens before sending requests to AI providers.",
  },
  {
    key: "telemetry.otlpExportEnabled",
    kind: "boolean",
    defaultValue: true,
    options: [],
    apply: "restart",
    registrySource: "telemetry-settings.ts:8-19",
    boundarySource: "main.ts:2227",
    description:
      "Allow omp to export traces, logs, and metrics to configured telemetry endpoints. Changes take effect after the next launch.",
  },
] as const;

describe("provider setting descriptors", () => {
  test("owns exactly the five provider sections and excludes provider services", () => {
    expect(PROVIDER_SETTINGS_SECTIONS.map(({ section: name }) => name)).toEqual([
      "providers/Fireworks",
      "providers/Tiny Model",
      "providers/Protocol",
      "providers/Timeouts",
      "providers/Privacy",
    ]);
    expect(PROVIDER_SETTINGS_SECTIONS.flatMap(({ inventory }) => inventory)).toEqual([
      "S5.providers-fireworks",
      "S5.providers-tiny-model",
      "S5.providers-protocol",
      "S5.providers-timeouts",
      "S5.providers-privacy",
    ]);
  });

  test("matches every omp registry row to its control, options, default, description and boundary", () => {
    const controls = Object.fromEntries(
      PROVIDER_SETTINGS_SECTIONS.flatMap(({ controls: values }) =>
        values.map((control) => [control.key, control]),
      ),
    );
    expect(Object.keys(controls).sort()).toEqual(
      OMP_PROVIDER_SETTINGS.map(({ key }) => key).sort(),
    );
    for (const expected of OMP_PROVIDER_SETTINGS) {
      const control = controls[expected.key];
      expect(control).toBeDefined();
      expect(control?.kind).toBe(expected.kind);
      expect(control?.defaultValue).toBe(expected.defaultValue);
      expect(control?.apply).toBe(expected.apply);
      expect(control?.registrySource).toBe(expected.registrySource);
      expect(control?.boundarySource).toBe(expected.boundarySource);
      expect(control?.description).toBe(expected.description);
      expect(control?.options?.map(({ value }) => value) ?? []).toEqual(expected.options);
    }
  });

  test("uses redacted typed controls and the live/restart boundaries from the registry", () => {
    const controls = PROVIDER_SETTINGS_SECTIONS.flatMap(({ controls: values }) => values);
    expect(controls).toHaveLength(14);
    expect(controls.every((control) => control.secret === false)).toBe(true);
    expect(controls.find((control) => control.key === "provider.appendOnlyContext")?.kind).toBe(
      "enum",
    );
    expect(
      controls
        .find((control) => control.key === "provider.appendOnlyContext")
        ?.options?.map(({ value }) => value),
    ).toEqual(["auto", "on", "off"]);
    expect(controls.find((control) => control.key === "providers.tinyModelDevice")?.apply).toBe(
      "live",
    );
    expect(controls.find((control) => control.key === "providers.openaiLiveSteering")?.apply).toBe(
      "live",
    );
    expect(controls.find((control) => control.key === "telemetry.otlpExportEnabled")?.apply).toBe(
      "restart",
    );
  });

  test("validates duration values and rejects invalid provider choices", () => {
    const timeouts = section("providers/Timeouts");
    const first = timeouts.controls[0];
    if (!first) throw new Error("Missing first timeout control");
    expect(first.validate({ secret: false, value: -1 }, {} as never)).toEqual({ valid: true });
    expect(first.validate({ secret: false, value: 600 }, {} as never)).toEqual({ valid: true });
    expect(first.validate({ secret: false, value: -2 }, {} as never)).toEqual({ valid: true });
    expect(first.validate({ secret: false, value: "600" }, {} as never)).toMatchObject({
      valid: false,
    });

    const fireworks = section("providers/Fireworks").controls[0];
    if (!fireworks) throw new Error("Missing Fireworks control");
    expect(fireworks.validate({ secret: false, value: "priority" }, {} as never)).toEqual({
      valid: true,
    });
    expect(fireworks.validate({ secret: false, value: "turbo" }, {} as never)).toMatchObject({
      valid: false,
    });
  });

  test("keeps provider values source-aware through the shared config capability", () => {
    for (const descriptor of PROVIDER_SETTINGS_SECTIONS) {
      expect(descriptor.requires).toEqual(["host.config"]);
      expect(descriptor.controls.every((control) => control.key.length > 0)).toBe(true);
    }
  });
});
