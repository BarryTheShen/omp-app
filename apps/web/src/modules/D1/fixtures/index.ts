import type { ConfigListResult, OmpWire, Revision } from "@omp-app/contracts";
import { FolderPath as FolderPathSchema } from "@omp-app/contracts";
import type { SessionInfoState } from "@/modules/R0/store/store";
import type { ModelRef } from "../contract";

/** Explicit inventory baseline: a new D1 row must get a descriptor and gate proof. */
export const D1_INVENTORY_ROWS = [
  "D1.get-available-thinking-levels",
  "D1.model",
  "D1.modelpreset",
  "D1.modelpreset-delete",
  "D1.modelpreset-list",
  "D1.modelpreset-save",
  "D1.modelpreset-switch",
  "D1.model-hub",
  "D1.effort",
  "D1.model-picker",
  "D1.thinking-level-selector",
  "D1.app-model-cyclebackward",
  "D1.app-model-cycleforward",
  "D1.app-model-select",
  "D1.app-model-selecttemporary",
  "D1.app-thinking-cycle",
] as const;
export type D1InventoryId = (typeof D1_INVENTORY_ROWS)[number];

/** D1 owns these six S2 sections; S2.model-advisor is owned by P1. */
export const D1_SETTINGS_INVENTORY_ROWS = [
  "S2.model-thinking",
  "S2.model-sampling",
  "S2.model-prompt",
  "S2.model-retry-fallback",
  "S2.model-prewalk",
  "S2.model-vision",
] as const;
export type D1SettingsInventoryId = (typeof D1_SETTINGS_INVENTORY_ROWS)[number];

export type D1FixtureScenario =
  | "catalog-rpc"
  | "scope-session"
  | "scope-default"
  | "thinking-rpc"
  | "settings-provenance"
  | "shortcut-descriptor"
  | "not-offered";

/** Each owned inventory row has one named fixture or descriptor-gate proof. */
export const D1_FIXTURE_COVERAGE = [
  {
    inventoryId: "D1.get-available-thinking-levels",
    scenario: "thinking-rpc",
    proof: "levels-result",
  },
  { inventoryId: "D1.model", scenario: "scope-session", proof: "session-model-apply" },
  { inventoryId: "D1.modelpreset", scenario: "scope-default", proof: "role-preset-store" },
  { inventoryId: "D1.modelpreset-delete", scenario: "scope-default", proof: "delete-preset" },
  { inventoryId: "D1.modelpreset-list", scenario: "scope-default", proof: "saved-presets" },
  { inventoryId: "D1.modelpreset-save", scenario: "scope-default", proof: "save-preset" },
  { inventoryId: "D1.modelpreset-switch", scenario: "scope-default", proof: "switch-preset" },
  { inventoryId: "D1.model-hub", scenario: "catalog-rpc", proof: "catalog-result" },
  { inventoryId: "D1.effort", scenario: "thinking-rpc", proof: "effort-level-cycle" },
  { inventoryId: "D1.model-picker", scenario: "catalog-rpc", proof: "catalog-loading-error" },
  {
    inventoryId: "D1.thinking-level-selector",
    scenario: "thinking-rpc",
    proof: "supported-levels",
  },
  {
    inventoryId: "D1.app-model-cyclebackward",
    scenario: "not-offered",
    proof: "omp's cycle_model RPC takes no backward direction",
  },
  {
    inventoryId: "D1.app-model-cycleforward",
    scenario: "shortcut-descriptor",
    proof: "shortcut-registry",
  },
  {
    inventoryId: "D1.app-model-select",
    scenario: "shortcut-descriptor",
    proof: "shortcut-registry",
  },
  {
    inventoryId: "D1.app-model-selecttemporary",
    scenario: "shortcut-descriptor",
    proof: "shortcut-registry",
  },
  {
    inventoryId: "D1.app-thinking-cycle",
    scenario: "shortcut-descriptor",
    proof: "shortcut-registry",
  },
  {
    inventoryId: "S2.model-thinking",
    scenario: "settings-provenance",
    proof: "thinking-settings-source",
  },
  {
    inventoryId: "S2.model-sampling",
    scenario: "settings-provenance",
    proof: "settings-descriptor",
  },
  {
    inventoryId: "S2.model-prompt",
    scenario: "settings-provenance",
    proof: "saved-default-source",
  },
  {
    inventoryId: "S2.model-retry-fallback",
    scenario: "settings-provenance",
    proof: "settings-descriptor",
  },
  {
    inventoryId: "S2.model-prewalk",
    scenario: "settings-provenance",
    proof: "settings-descriptor",
  },
  { inventoryId: "S2.model-vision", scenario: "settings-provenance", proof: "settings-descriptor" },
] as const satisfies ReadonlyArray<{
  readonly inventoryId: D1InventoryId | D1SettingsInventoryId;
  readonly scenario: D1FixtureScenario;
  readonly proof: string;
}>;

/**
 * Scripted, secret-free examples use omp v18.6.1's actual RPC payloads:
 * `packages/coding-agent/src/modes/rpc/rpc-mode.ts:2092-2110` returns a ModelInfo from
 * `set_model`; `:2121-2124` returns `{ models: ModelInfo[] }` from `get_available_models`;
 * `:2144-2152` returns `{ levels: ThinkingLevel[] }` from `get_available_thinking_levels`.
 * Wire shape: `packages/contracts/src/omp-wire/rpc-wire.generated.ts:316-367,1505-1520`.
 */
const reasonerModel: OmpWire.ModelInfo = {
  id: "reasoner-large",
  name: "Reasoner Large",
  api: "openai-completions",
  provider: "fixture-provider",
  baseUrl: "https://api.fixture.invalid/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinking: { mode: "enabled", efforts: ["low", "medium", "high"], defaultLevel: "medium" },
};

const fastModel: OmpWire.ModelInfo = {
  id: "fast-chat",
  name: "Fast Chat",
  api: "openai-completions",
  provider: "fixture-provider",
  baseUrl: "https://api.fixture.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.2, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
  thinking: { mode: "enabled", efforts: ["low", "medium"], defaultLevel: "low" },
};

export const D1_MODEL_CATALOG_RPC_FIXTURE: OmpWire.GetAvailableModelsResult = {
  models: [reasonerModel, fastModel],
};

export const D1_SET_MODEL_RPC_FIXTURE: OmpWire.ModelInfo = fastModel;

export const D1_THINKING_LEVELS_RPC_FIXTURE: OmpWire.GetAvailableThinkingLevelsResult = {
  levels: ["off", "low", "medium", "high"],
};

/** R0's get_state projection uses `snapshot.session.model` and `thinkingLevel`. */
export const D1_R0_SNAPSHOT_FIXTURE = {
  session: {
    model: reasonerModel,
    thinkingLevel: "high",
  } satisfies Pick<SessionInfoState, "model" | "thinkingLevel">,
} as const;

export const D1_SESSION_MODEL_FIXTURE: ModelRef = {
  provider: "fixture-provider",
  modelId: "reasoner-large",
};
export const D1_SAVED_DEFAULT_FIXTURE: ModelRef = {
  provider: "fixture-provider",
  modelId: "fast-chat",
};
export const D1_SAVED_DEFAULT_SOURCE_FIXTURE = "project" as const;
export const D1_PROJECT_FOLDER_FIXTURE = FolderPathSchema.parse("/workspace/omp-project");

const modelConfigProvenance = {
  origin: "omp-config",
  ompVersion: "18.6.1",
  path: "<WORKSPACE>/.omp/config.yml",
} as const;
const projectLayerOverrides = ["global", "default"] as const;

/** A1 ConfigStore list response with explicit omp source, lower-layer overrides and safe provenance. */
export const D1_SETTINGS_CONFIG_FIXTURE: ConfigListResult = {
  entries: [
    {
      key: "modelRoleStorage",
      secret: false,
      value: "project",
      source: "project",
      overrides: [...projectLayerOverrides],
      provenance: modelConfigProvenance,
    },
    {
      key: "modelRoles",
      secret: false,
      value: { default: "fixture-provider/fast-chat" },
      source: "project",
      overrides: [...projectLayerOverrides],
      provenance: modelConfigProvenance,
    },
    {
      key: "defaultThinkingLevel",
      secret: false,
      value: "high",
      source: "project",
      overrides: [...projectLayerOverrides],
      provenance: modelConfigProvenance,
    },
  ],
  revision: "d1-project-config-1" as Revision,
};
