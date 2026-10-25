import type { CapabilityKey, JsonValue } from "@omp-app/contracts";
import {
  type ScalarSettingControl,
  type SettingsSectionDescriptor,
  type SettingValue,
  settingOptions,
  type ValidationResult,
} from "../../S1/settings-kit";

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];

/**
 * Memory settings correspond to omp v18.12.6's Memory sections. The setting-schema ranges are
 * recorded in research/modules/I3.md:26-30 and research/omp-feature-inventory.md:879-884.
 * ConfigStore remains authoritative for effective values, provenance and revisions.
 */
const BACKENDS = ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const;
const SCOPES = ["global", "per-project", "per-project-tagged"] as const;
const RETAIN_MODES = ["full-session", "last-turn"] as const;
const EMBEDDING_VARIANTS = ["en", "multilingual"] as const;
const LLM_MODES = ["none", "smol", "remote"] as const;

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function invalid(code: string, message: string): ValidationResult {
  return { valid: false, code, message };
}

function text(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && !candidate.includes("\0")
    ? { valid: true }
    : invalid("text", "Enter text without an invalid character.");
}

function boolean(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : invalid("boolean", "Choose on or off.");
}

function enumValue(values: readonly string[]) {
  return (value: SettingValue): ValidationResult =>
    typeof plain(value) === "string" && values.includes(plain(value) as string)
      ? { valid: true }
      : invalid("choice", "Choose one of the available options.");
}

function scalar(
  key: string,
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  options?: ScalarSettingControl["options"],
  description?: string,
): ScalarSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    validate,
    apply: key === "mnemopi.embeddingVariant" ? "restart" : "live",
    ...(options === undefined ? {} : { options }),
    ...(description === undefined ? {} : { description }),
  };
}

function secret(key: string, label: string, description: string): ScalarSettingControl {
  return {
    key,
    label,
    kind: "secret",
    secret: true,
    validate: () => ({ valid: true }),
    apply: "live",
    description,
  };
}

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly ScalarSettingControl[],
): SettingsSectionDescriptor {
  return { id, section: sectionName, title, inventory, controls, requires: [...HOST_CONFIG] };
}

export const MEMORY_GENERAL_SETTINGS_SECTION = section(
  "I3.memoryGeneral",
  "memory/General",
  "Memory",
  ["S5.memory-general"],
  [
    scalar(
      "memory.backend",
      "Memory Backend",
      "enum",
      enumValue(BACKENDS),
      settingOptions(BACKENDS),
      "Where memory is stored and recalled.",
    ),
  ],
);

export const MEMORY_AUTO_LEARN_SETTINGS_SECTION = section(
  "I3.memoryAutoLearn",
  "memory/Auto-Learn",
  "Auto-Learn",
  ["S5.memory-auto-learn"],
  [
    scalar(
      "autolearn.enabled",
      "Auto-Learn (experimental)",
      "boolean",
      boolean,
      undefined,
      "Capture useful lessons automatically.",
    ),
    scalar(
      "autolearn.autoContinue",
      "Auto-run capture at stop",
      "boolean",
      boolean,
      undefined,
      "Run capture when a turn stops.",
    ),
  ],
);

export const MEMORY_HINDSIGHT_SETTINGS_SECTION = section(
  "I3.memoryHindsight",
  "memory/Hindsight",
  "Hindsight",
  ["S5.memory-hindsight"],
  [
    scalar("hindsight.apiUrl", "API URL", "text", text),
    secret(
      "hindsight.apiToken",
      "API Token",
      "The token is never shown here; only whether one is set is visible.",
    ),
    scalar("hindsight.bankId", "Bank ID", "text", text, undefined, "The Hindsight bank to use."),
    scalar(
      "hindsight.scoping",
      "Scoping",
      "enum",
      enumValue(SCOPES),
      settingOptions(SCOPES),
      "Which memory scope Hindsight uses.",
    ),
    scalar(
      "hindsight.autoRecall",
      "Auto Recall",
      "boolean",
      boolean,
      undefined,
      "Recall relevant memories automatically.",
    ),
    scalar(
      "hindsight.autoRetain",
      "Auto Retain",
      "boolean",
      boolean,
      undefined,
      "Retain useful memories automatically.",
    ),
    scalar(
      "hindsight.retainMode",
      "Retain Mode",
      "enum",
      enumValue(RETAIN_MODES),
      settingOptions(RETAIN_MODES),
      "How retained memories are submitted.",
    ),
    scalar(
      "hindsight.mentalModelsEnabled",
      "Mental Models",
      "boolean",
      boolean,
      undefined,
      "Enable Hindsight mental models.",
    ),
    scalar(
      "hindsight.mentalModelAutoSeed",
      "Seed Mental Models",
      "boolean",
      boolean,
      undefined,
      "Seed missing built-in mental models.",
    ),
  ],
);

export const MEMORY_MNEMOPI_SETTINGS_SECTION = section(
  "I3.memoryMnemopi",
  "memory/Mnemopi",
  "Mnemopi",
  ["S5.memory-mnemopi"],
  [
    scalar(
      "mnemopi.dbPath",
      "Database Path",
      "text",
      text,
      undefined,
      "The Mnemopi database location.",
    ),
    scalar("mnemopi.bank", "Bank", "text", text, undefined, "The Mnemopi bank to use."),
    scalar(
      "mnemopi.scoping",
      "Scoping",
      "enum",
      enumValue(SCOPES),
      settingOptions(SCOPES),
      "Which memory scope Mnemopi uses.",
    ),
    scalar(
      "mnemopi.embeddingVariant",
      "Embedding Variant",
      "enum",
      enumValue(EMBEDDING_VARIANTS),
      settingOptions(EMBEDDING_VARIANTS, {
        en: "English (bge-base-en-v1.5)",
        multilingual: "Multilingual (multilingual-e5-large)",
      }),
      "The embedding service variant.",
    ),
    scalar("mnemopi.autoRecall", "Auto Recall", "boolean", boolean),
    scalar("mnemopi.autoRetain", "Auto Retain", "boolean", boolean),
    scalar("mnemopi.polyphonicRecall", "Polyphonic Recall", "boolean", boolean),
    scalar("mnemopi.enhancedRecall", "Enhanced Recall", "boolean", boolean),
    scalar("mnemopi.proactiveLinking", "Proactive Linking", "boolean", boolean),
    scalar("mnemopi.noEmbeddings", "Disable Embeddings", "boolean", boolean),
    scalar("mnemopi.embeddingModel", "Embedding Model", "text", text),
    scalar("mnemopi.embeddingApiUrl", "Embedding API URL", "text", text),
    secret(
      "mnemopi.embeddingApiKey",
      "Embedding API Key",
      "The key is never shown here; only whether one is set is visible.",
    ),
    scalar(
      "mnemopi.llmMode",
      "Language Model Mode",
      "enum",
      enumValue(LLM_MODES),
      settingOptions(LLM_MODES, { none: "None", smol: "Online (tiny)", remote: "Remote" }),
      "The language model service.",
    ),
    scalar("mnemopi.llmBaseUrl", "Language Model Base URL", "text", text),
    secret(
      "mnemopi.llmApiKey",
      "Language Model API Key",
      "The key is never shown here; only whether one is set is visible.",
    ),
    scalar("mnemopi.llmModel", "Mnemopi LLM Model", "text", text),
  ],
);

export const MEMORY_SHARPSHOOTER_SETTINGS_SECTION = section(
  "I3.memorySharpshooter",
  "memory/Sharpshooter",
  "Sharpshooter",
  ["S5.memory-sharpshooter"],
  [scalar("sharpshooter.model", "Sharpshooter Model", "text", text)],
);

export const MEMORY_SETTINGS_SECTIONS = [
  MEMORY_GENERAL_SETTINGS_SECTION,
  MEMORY_AUTO_LEARN_SETTINGS_SECTION,
  MEMORY_HINDSIGHT_SETTINGS_SECTION,
  MEMORY_MNEMOPI_SETTINGS_SECTION,
  MEMORY_SHARPSHOOTER_SETTINGS_SECTION,
] as const;
