import { describe, expect, test } from "vitest";
import { ADVISOR_SETTING_DEFINITIONS } from "@/modules/P1/advisor/model";
import { P7_CONTEXT_SETTINGS_SECTIONS } from "@/modules/P7/settings";
import { SETTINGS_SECTIONS } from "@/registry";
import registry from "./fixtures/omp-settings-registry.v18.12.6.json";

type RegistrySetting = (typeof registry.settings)[number];
type Control = (typeof SETTINGS_SECTIONS)[number]["controls"][number];

/**
 * App controls with no entry in the registry fixture: the magic-keyword ids omp creates in a loop (the literal-register
 * extractor cannot see them).
 */
const NOT_IN_THE_FIXTURE: Readonly<Record<string, string>> = {
  "magicKeywords.ultrathink":
    "generated in omp's magic-keyword loop; absent from literal register calls",
  "magicKeywords.orchestrate":
    "generated in omp's magic-keyword loop; absent from literal register calls",
  "magicKeywords.workflow":
    "generated in omp's magic-keyword loop; absent from literal register calls",
  "magicKeywords.jevify":
    "generated in omp's magic-keyword loop; absent from literal register calls",
};
/** These enum values are identifier-valued in omp, so the literal-register extractor omits them. */
const IDENTIFIER_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  // omp v18.12.6 tiny/device.ts:74-94 (the file is identical at v18.9.1)
  "providers.tinyModelDevice": [
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
  // omp v18.12.6 tiny/dtype.ts:49-68 (the file is identical at v18.9.1)
  "providers.tinyModelDtype": [
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
};

/** These controls intentionally use a different shape than omp's persisted setting registration. */
const DESIGN_DIFFERENCES: Readonly<Record<string, string>> = {
  "advisor.immuneTurns":
    "the app's select stores the numeric menu values exposed by omp's number setting (0 to 5 turns)",
  "compaction.thresholdPercent":
    "the app's select stores the numeric sentinel values exposed by omp's number menu",
  "compaction.thresholdTokens":
    "the app's select stores the numeric sentinel values exposed by omp's number menu",
  "snapcompact.shape":
    "the option table is supplied by omp's external snapcompact package, not this checkout",
  "ttsr.repeatGap":
    "the app's select stores the numeric menu values exposed by omp's number setting",
};

const ALL_SECTIONS = [...SETTINGS_SECTIONS, ...P7_CONTEXT_SETTINGS_SECTIONS];
const ALL_CONTROLS = ALL_SECTIONS.flatMap((section) => section.controls);
const SERVICE_TIER_KEYS = [
  "tier.openai",
  "tier.anthropic",
  "tier.google",
  "tier.subagent",
  "tier.advisor",
] as const;

function registryFor(key: string): RegistrySetting | undefined {
  return registry.settings.find((setting) => setting.id === key);
}

function controlFor(key: string): Control | undefined {
  return ALL_CONTROLS.find((control) => control.key === key);
}

function appType(control: Control): string {
  switch (control.kind) {
    case "list":
    case "rows":
      return "array";
    case "map":
      return "record";
    case "path":
    case "text":
      return "string";
    case "duration":
      return "number";
    case "secret":
      return "string";
    default:
      return control.kind;
  }
}

function optionValues(control: Control): readonly string[] {
  return control.kind === "enum"
    ? (control.options
        ?.map((option) => option.value)
        .filter((value): value is string => typeof value === "string") ?? [])
    : [];
}

describe("settings descriptors match omp's v18.12.6 registration", () => {
  test("every app control has a registry entry or a named extractor exception, with matching type", () => {
    const mismatches: string[] = [];
    for (const control of ALL_CONTROLS) {
      const source = registryFor(control.key);
      if (source === undefined) {
        if (NOT_IN_THE_FIXTURE[control.key] !== undefined) continue;
        mismatches.push(`${control.key}: missing from omp's registry`);
        continue;
      }
      if (appType(control) !== source.type && DESIGN_DIFFERENCES[control.key] === undefined) {
        mismatches.push(`${control.key}: app kind ${control.kind} is ${source.type} in omp`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("matches every registered enum's ordered values", () => {
    const mismatches: string[] = [];
    for (const control of ALL_CONTROLS) {
      const source = registryFor(control.key);
      if (
        control.kind !== "enum" ||
        source?.type !== "enum" ||
        source.values === undefined ||
        DESIGN_DIFFERENCES[control.key] !== undefined
      ) {
        continue;
      }
      const actual = optionValues(control);
      const expected = IDENTIFIER_ENUM_VALUES[control.key] ?? source.values;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `${control.key}: options ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("keeps each service-tier control present with the exact omp enum values", () => {
    for (const key of SERVICE_TIER_KEYS) {
      const source = registryFor(key);
      expect(source, `${key} registry entry`).toBeDefined();
      expect(source?.type, `${key} registry type`).toBe("enum");
      expect(source?.values?.length, `${key} registry values`).toBeGreaterThan(0);

      const control = controlFor(key);
      expect(control, `${key} app control`).toBeDefined();
      if (!control || !source?.values) continue;
      expect(control.kind, `${key} app type`).toBe("enum");
      expect(optionValues(control), `${key} app values`).toEqual(source.values);
    }
  });

  test("limits app controls without a registry entry to the magic-keyword settings and the two omp removed", () => {
    const missingFromRegistry = ALL_CONTROLS.map((control) => control.key)
      .filter((key) => registryFor(key) === undefined)
      .sort();
    expect(missingFromRegistry).toEqual(Object.keys(NOT_IN_THE_FIXTURE).sort());
    for (const key of Object.keys(NOT_IN_THE_FIXTURE)) {
      expect(controlFor(key), `${key} app control`).toBeDefined();
      expect(registryFor(key), `${key} has no entry in the registry fixture`).toBeUndefined();
    }
  });

  /** The six settings omp's own settings screen gained in 18.12.x (they carry `ui` metadata in omp's registry). */
  const ADDED_TO_OMP_SETTINGS_SCREEN = [
    "advisor.continueSeverity",
    "prewalk.auto",
    "prewalk.autoTarget",
    "async.widgets",
    "computer.backgroundFallback",
    "tui.completeScrollback",
  ] as const;

  test("has a control for each setting omp 18.12.x added to its settings screen, with omp's label, values and default", () => {
    for (const key of ADDED_TO_OMP_SETTINGS_SCREEN) {
      const source = registryFor(key);
      expect(source?.ui?.label, `${key} registry label`).toBeDefined();
      const control = controlFor(key);
      // The advisor settings live on P1's advisor surface, not in a settings section.
      const advisor = ADVISOR_SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
      expect(control ?? advisor, `${key} app control`).toBeDefined();
      expect((control?.label ?? advisor?.label ?? "").toLowerCase(), `${key} label`).toBe(
        (source?.ui?.label ?? "").toLowerCase(),
      );
      if (source?.type !== "enum") continue;
      const values = advisor
        ? (advisor.options ?? []).map((option) => option.value)
        : control
          ? optionValues(control)
          : [];
      expect(values, `${key} values`).toEqual(source.values);
      expect(values, `${key} lists omp's default`).toContain(source.default);
      if (advisor) expect(advisor.defaultValue, `${key} default`).toBe(source.default);
    }
  });
});
