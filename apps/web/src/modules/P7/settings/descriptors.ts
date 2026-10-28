import type { CapabilityKey, JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { settingOptions } from "../../S1/settings-kit";

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];
/**
 * omp v18.12.6 setting registrations and option labels:
 * `packages/coding-agent/src/session/context-settings.ts` and
 * `packages/coding-agent/src/export/ttsr-settings.ts`. Method choices/default come from
 * `packages/coding-agent/src/session/compaction-methods.ts`.
 */

/** omp v18.12.6 defaults from `session/compaction-methods.ts`. */
export const DEFAULT_COMPACTION_METHOD_ORDER = [
  "remote",
  "snapcompact",
  "handoff",
  "shake",
  "soft",
] as const;

const COMPACTION_METHOD_VALUES = ["remote", "snapcompact", "handoff", "soft", "shake"] as const;
const COMPACTION_METHOD_OPTIONS = settingOptions(COMPACTION_METHOD_VALUES, {
  remote: "Server compaction",
  snapcompact: "Snapcompact",
  handoff: "Handoff",
  soft: "Soft compaction",
  shake: "Shake",
});

const COMPACTION_PERCENT_VALUES = [
  "-1",
  "10",
  "20",
  "30",
  "40",
  "50",
  "60",
  "70",
  "75",
  "80",
  "85",
  "90",
  "95",
] as const;
const COMPACTION_PERCENT_OPTIONS = settingOptions(COMPACTION_PERCENT_VALUES, {
  "-1": "Default",
  "10": "10 percent",
  "20": "20 percent",
  "30": "30 percent",
  "40": "40 percent",
  "50": "50 percent",
  "60": "60 percent",
  "70": "70 percent",
  "75": "75 percent",
  "80": "80 percent",
  "85": "85 percent",
  "90": "90 percent",
  "95": "95 percent",
});

const COMPACTION_TOKEN_VALUES = [
  "-1",
  "25000",
  "50000",
  "100000",
  "150000",
  "200000",
  "300000",
  "500000",
] as const;
const COMPACTION_TOKEN_OPTIONS = settingOptions(COMPACTION_TOKEN_VALUES, {
  "-1": "Default",
  "25000": "25,000 tokens",
  "50000": "50,000 tokens",
  "100000": "100,000 tokens",
  "150000": "150,000 tokens",
  "200000": "200,000 tokens",
  "300000": "300,000 tokens",
  "500000": "500,000 tokens",
});

const SNAPCOMPACT_PROMPT_VALUES = ["none", "agents-md", "all"] as const;
const SNAPCOMPACT_PROMPT_OPTIONS = settingOptions(SNAPCOMPACT_PROMPT_VALUES, {
  none: "None",
  "agents-md": "AGENTS.md",
  all: "All",
});

const TOOL_FORMAT_VALUES = [
  "auto",
  "native",
  "glm",
  "hermes",
  "kimi",
  "xml",
  "anthropic",
  "deepseek",
  "harmony",
  "qwen3",
  "gemini",
  "gemma",
  "minimax",
] as const;
const TOOL_FORMAT_OPTIONS = settingOptions(TOOL_FORMAT_VALUES, {
  auto: "Automatic",
  native: "Provider-native",
  glm: "GLM-style",
  hermes: "Hermes",
  kimi: "Kimi",
  xml: "XML",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  harmony: "Harmony",
  qwen3: "Qwen3",
  gemini: "Gemini",
  gemma: "Gemma",
  minimax: "MiniMax",
});

const SNAPCOMPACT_SHAPE_VALUES = [
  "auto",
  "8x8r-bw",
  "8x8r-sent",
  "8x8u-bw",
  "8x8u-sent",
  "6x6u-bw",
  "6x6u-sent",
  "5x8-bw",
  "5x8-sent",
  "6x12-dim",
  "8x13-bw",
  "8on16-bw",
  "8on22-bw",
  "11on16-bw",
  "silver16-bw",
  "doc-8on16-bw",
  "doc-8on16-sent",
  "doc-8on16-sent-dim",
] as const;
const SNAPCOMPACT_SHAPE_OPTIONS = settingOptions(SNAPCOMPACT_SHAPE_VALUES, {
  auto: "Automatic",
  "8x8r-bw": "8×8 repeated, black",
  "8x8r-sent": "8×8 repeated, sentence colors",
  "8x8u-bw": "8×8, black",
  "8x8u-sent": "8×8, sentence colors",
  "6x6u-bw": "6×6 dense, black",
  "6x6u-sent": "6×6 dense, sentence colors",
  "5x8-bw": "5×8 legacy, black",
  "5x8-sent": "5×8 legacy, sentence colors",
  "6x12-dim": "6×12, dimmed stopwords",
  "8x13-bw": "8×13, black",
  "8on16-bw": "8×13 on 16px pitch, black",
  "8on22-bw": "8×13 on 22px pitch (leading), black",
  "11on16-bw": "11×16 cells on 11px advance (tracking), black",
  "silver16-bw": "Silver 16, CJK",
  "doc-8on16-bw": "Document, 8×13 on 16px pitch, black",
  "doc-8on16-sent": "Document, 8×13 on 16px pitch, sentence colors",
  "doc-8on16-sent-dim": "Document, 8×13 on 16px pitch, sentence colors with dimmed stopwords",
});

const TTSR_JUDGE_VALUES = ["auto", "on", "off"] as const;
const TTSR_JUDGE_OPTIONS = settingOptions(TTSR_JUDGE_VALUES, {
  auto: "Automatic",
  on: "Always",
  off: "Never",
});
const TTSR_CONTEXT_VALUES = ["discard", "keep"] as const;
const TTSR_CONTEXT_OPTIONS = settingOptions(TTSR_CONTEXT_VALUES, {
  discard: "Discard partial output",
  keep: "Keep partial output",
});

const TTSR_INTERRUPT_VALUES = ["never", "prose-only", "tool-only", "always"] as const;
const TTSR_INTERRUPT_OPTIONS = settingOptions(TTSR_INTERRUPT_VALUES, {
  never: "Never interrupt",
  "prose-only": "Interrupt for replies only",
  "tool-only": "Interrupt for tool calls only",
  always: "Interrupt for replies and tool calls",
});

const TTSR_REPEAT_VALUES = ["once", "after-gap"] as const;
const TTSR_REPEAT_OPTIONS = settingOptions(TTSR_REPEAT_VALUES, {
  once: "Once per session",
  "after-gap": "After a message gap",
});

const TTSR_REPEAT_GAP_VALUES = ["5", "10", "15", "20", "30"] as const;
const TTSR_REPEAT_GAP_OPTIONS = settingOptions(TTSR_REPEAT_GAP_VALUES, {
  "5": "5 messages",
  "10": "10 messages",
  "15": "15 messages",
  "20": "20 messages",
  "30": "30 messages",
});

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function invalid(message: string): ValidationResult {
  return { valid: false, code: "invalid-value", message };
}

function validateBoolean(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean" ? { valid: true } : invalid("Choose on or off.");
}

function validateEnum(values: readonly string[]) {
  return (value: SettingValue): ValidationResult => {
    const candidate = plain(value);
    return typeof candidate === "string" && values.includes(candidate)
      ? { valid: true }
      : invalid("Choose one of the available options.");
  };
}

/** omp registers these as plain numbers. The menu offers some of them; any finite number is valid, so a stored value off the menu still saves. */
function validateNumber(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  const number =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string"
        ? Number(candidate)
        : Number.NaN;
  return Number.isFinite(number) ? { valid: true } : invalid("Enter a number.");
}

function validateStringList(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return Array.isArray(candidate) &&
    candidate.every((item) => typeof item === "string" && !item.includes("\0"))
    ? { valid: true }
    : invalid("Each entry must be plain text.");
}
const BUILTIN_CONTEXT_FILE_NAMES: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "copilot-instructions.md",
]);

function validateContextFileNames(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (!Array.isArray(candidate)) return invalid("Enter a list of extra context filenames.");
  for (const item of candidate) {
    if (typeof item !== "string") return invalid("Each extra context filename must be text.");
    const name = item.trim();
    if (name.length === 0) return invalid("Extra context filenames cannot be empty.");
    if (BUILTIN_CONTEXT_FILE_NAMES.has(name.toLowerCase())) {
      return invalid("Do not list a built-in context filename.");
    }
    if (
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      return invalid("Enter filenames only, not paths.");
    }
  }
  return { valid: true };
}

const COMPACTION_METHODS: Readonly<Record<string, true>> = {
  remote: true,
  snapcompact: true,
  handoff: true,
  soft: true,
  shake: true,
};

function validateCompactionMethods(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return invalid("Choose at least one compaction method.");
  }
  if (
    candidate.some((item) => typeof item !== "string" || COMPACTION_METHODS[item] !== true) ||
    new Set(candidate).size !== candidate.length
  ) {
    return invalid("Choose supported compaction methods without duplicates.");
  }
  return { valid: true };
}

/**
 * Where omp v18.12.6 reads each key (in the app's chat host, so a saved change applies to the open session).
 * Each reference is a file:line in omp's source, from the audit of the 30 registrations in
 * `session/context-settings.ts` and `export/ttsr-settings.ts`:
 * - workspace.additionalDirectories: session/agent-session.ts:2821 (listener: #syncSettingsWorkspaceDirectories :2836)
 * - contextPromotion.enabled: session/session-maintenance.ts:3132,3373,3431; session/session-advisors.ts:2262
 * - extendedContext: session/agent-session.ts:2646 (listener); config/model-registry.ts:232
 * - compaction.enabled: session/session-maintenance.ts:627,1081,2143; modes/rpc/rpc-mode.ts:2389 (set_auto_compaction)
 * - compaction.midTurnEnabled: session/session-maintenance.ts:2712
 * - compaction.methodOrder: session/session-maintenance.ts:1239,2829; session/compaction-methods.ts (resolveCompactionMethodOrder)
 * - compaction.thresholdPercent, compaction.thresholdTokens: agent/src/compaction/compaction.ts:354-411; session/session-maintenance.ts:628,2148,3356
 * - compaction.handoffSaveToDisk: session/session-handoff.ts:213
 * - compaction.remoteStreamingV2Enabled: agent/src/compaction/compaction.ts:238-243,1777
 * - compaction.asyncEnabled: session/session-maintenance.ts:2143,2237,2452; session/context-usage-runtime.ts:32
 * - compaction.supersedeReads, compaction.dropUseless: session/session-maintenance.ts:726,755-775
 * - compaction.experimentalContextManagement: session/session-maintenance.ts:614; tools/index.ts:684,764 (tools/settings.ts:1064-1087)
 * - ttsr.enabled, ttsr.contextMode, ttsr.interruptMode, ttsr.repeatMode, ttsr.repeatGap: sdk.ts:2207-2209 (live source)
 * - ttsr.judge: session/agent-session.ts:3330
 * - ttsr.builtinRules, ttsr.disabledRules: system-prompt.ts:41,89-90 (prompt rebuild, sdk.ts:4917-4938)
 * - snapcompact.systemPrompt, snapcompact.toolResults, snapcompact.shape: sdk.ts:4384-4390; session/context-usage-runtime.ts:47-51
 * - tools.format: sdk.ts:4090,4622,5427; system-prompt.ts:71
 * Terminal only, so the app ignores them: branchSummary.enabled (modes/controllers/selector-controller.ts:1547),
 * compaction.idleEnabled, compaction.idleThresholdTokens, compaction.idleTimeoutSeconds
 * (modes/controllers/event-controller.ts:2795-2823).
 */
function settingControl(
  key: SettingControl["key"],
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  description: string,
  options?: readonly SettingOption[],
): ScalarSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    validate,
    apply: "live",
    description,
    ...(options === undefined ? {} : { options }),
  };
}

function booleanControl(key: string, label: string, description: string): ScalarSettingControl {
  return settingControl(key, label, "boolean", validateBoolean, description);
}

function enumControl(
  key: string,
  label: string,
  values: readonly string[],
  options: readonly SettingOption[],
  description: string,
): ScalarSettingControl {
  return settingControl(key, label, "enum", validateEnum(values), description, options);
}

function numberChoiceControl(
  key: string,
  label: string,
  options: readonly SettingOption[],
  description: string,
): ScalarSettingControl {
  return settingControl(key, label, "enum", validateNumber, description, options);
}

const GENERAL_SETTINGS: readonly SettingControl[] = [
  settingControl(
    "workspace.additionalDirectories",
    "Additional Workspace Directories",
    "list",
    validateStringList,
    "Add extra workspace folders that every session can read and search. Relative paths use the current project folder; absolute paths are recommended.",
  ),
  booleanControl(
    "contextPromotion.enabled",
    "Auto-Promote Context",
    "Switch to a model with a larger context window when the current one fills up, instead of compacting first.",
  ),
  booleanControl(
    "extendedContext",
    "Extended Context",
    "Use larger context windows when a model supports them. Higher limits may cost more.",
  ),
  settingControl(
    "contextFiles.extra",
    "Extra Context Files",
    "list",
    validateContextFileNames,
    "Extra instruction filenames loaded beside AGENTS.md. Enter filenames only, not paths. Start a new session to load changes.",
  ),
];

const COMPACTION_SETTINGS: readonly SettingControl[] = [
  booleanControl(
    "compaction.enabled",
    "Auto-Compact",
    "Automatically compact context when it gets too large.",
  ),
  booleanControl(
    "compaction.midTurnEnabled",
    "Mid-Turn Compaction",
    "Check the context threshold between tool steps, before the next model request.",
  ),
  settingControl(
    "compaction.methodOrder",
    "Compaction Method Order",
    "list",
    validateCompactionMethods,
    "Choose the fallback order for automatic context maintenance. Unavailable or failed methods are skipped.",
    COMPACTION_METHOD_OPTIONS,
  ),
  numberChoiceControl(
    "compaction.thresholdPercent",
    "Compaction Threshold",
    COMPACTION_PERCENT_OPTIONS,
    "Choose the context-window percentage where automatic maintenance begins, or use the default.",
  ),
  numberChoiceControl(
    "compaction.thresholdTokens",
    "Compaction Token Limit",
    COMPACTION_TOKEN_OPTIONS,
    "Choose the token count where automatic maintenance begins. This overrides the percentage threshold.",
  ),
  booleanControl(
    "compaction.handoffSaveToDisk",
    "Save Handoff Documents",
    "Save generated handoff notes as Markdown files when context is handed off.",
  ),
  booleanControl(
    "compaction.remoteStreamingV2Enabled",
    "Remote Compaction V2",
    "Use streaming server compaction when the active route supports it.",
  ),
  booleanControl(
    "compaction.asyncEnabled",
    "Async Compaction",
    "Prepare a summary in the background as context approaches its threshold.",
  ),
  booleanControl(
    "compaction.supersedeReads",
    "Supersede Stale Reads",
    "Remove older file-reading results when the same file is read again.",
  ),
  booleanControl(
    "compaction.dropUseless",
    "Elide Uneventful Results",
    "Prune tool results that did not add useful context, such as empty searches or timed-out waits.",
  ),
  booleanControl(
    "compaction.experimentalContextManagement",
    "Notes-Backed Context Windows (Experimental)",
    "Keep persistent notes and searchable history across context windows.",
  ),
];

const RULES_SETTINGS: readonly SettingControl[] = [
  booleanControl(
    "ttsr.enabled",
    "TTSR",
    "Interrupt the agent when its output matches a time-traveling stream rule.",
  ),
  enumControl(
    "ttsr.judge",
    "Judged Rules",
    TTSR_JUDGE_VALUES,
    TTSR_JUDGE_OPTIONS,
    "Choose whether the judge model checks rules that ask a question.",
  ),
  enumControl(
    "ttsr.contextMode",
    "TTSR Context Mode",
    TTSR_CONTEXT_VALUES,
    TTSR_CONTEXT_OPTIONS,
    "Choose what happens to partial output when a rule triggers.",
  ),
  enumControl(
    "ttsr.interruptMode",
    "TTSR Interrupt Mode",
    TTSR_INTERRUPT_VALUES,
    TTSR_INTERRUPT_OPTIONS,
    "Choose when a matching rule interrupts a response or tool call.",
  ),
  enumControl(
    "ttsr.repeatMode",
    "TTSR Repeat Mode",
    TTSR_REPEAT_VALUES,
    TTSR_REPEAT_OPTIONS,
    "Choose whether a rule runs once per session or can run again after a message gap.",
  ),
  numberChoiceControl(
    "ttsr.repeatGap",
    "TTSR Repeat Gap",
    TTSR_REPEAT_GAP_OPTIONS,
    "Choose how many messages must pass before a rule can run again.",
  ),
  booleanControl("ttsr.builtinRules", "Built-In Rules", "Load the default rules shipped with omp."),
  settingControl(
    "ttsr.disabledRules",
    "Disabled Rules",
    "list",
    validateStringList,
    "List rule names to ignore, including bundled defaults and your own rules.",
  ),
];

const EXPERIMENTAL_SETTINGS: readonly SettingControl[] = [
  enumControl(
    "snapcompact.systemPrompt",
    "Snapcompact System Prompt",
    SNAPCOMPACT_PROMPT_VALUES,
    SNAPCOMPACT_PROMPT_OPTIONS,
    "Choose which system-prompt text to render as images for vision models.",
  ),
  booleanControl(
    "snapcompact.toolResults",
    "Snapcompact Tool Results",
    "Render large tool results, the newest one included, as images for vision models instead of keeping their text. Saves tokens on search and command output; read results stay text unless the model is known to edit exactly from images.",
  ),
  enumControl(
    "tools.format",
    "Tool Calling Mode",
    TOOL_FORMAT_VALUES,
    TOOL_FORMAT_OPTIONS,
    "Choose how tools are presented to the model. Automatic uses the model's supported format.",
  ),
  enumControl(
    "snapcompact.shape",
    "Snapcompact Shape",
    SNAPCOMPACT_SHAPE_VALUES,
    SNAPCOMPACT_SHAPE_OPTIONS,
    "Choose the frame shape used for compacted text images, or let omp choose for the active model.",
  ),
];

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"][number],
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return {
    id,
    section: sectionName,
    title,
    inventory: [inventory],
    controls,
    requires: HOST_CONFIG,
  };
}

export const CONTEXT_GENERAL_SETTINGS = section(
  "P7.contextGeneral",
  "context/General",
  "General",
  "S4.context-general",
  GENERAL_SETTINGS,
);

export const CONTEXT_COMPACTION_SETTINGS = section(
  "P7.contextCompaction",
  "context/Compaction",
  "Compaction",
  "S4.context-compaction",
  COMPACTION_SETTINGS,
);

export const CONTEXT_RULES_SETTINGS = section(
  "P7.contextRulesTtsr",
  "context/Rules (TTSR)",
  "Rules (TTSR)",
  "S4.context-rules-ttsr",
  RULES_SETTINGS,
);

export const CONTEXT_EXPERIMENTAL_SETTINGS = section(
  "P7.contextExperimental",
  "context/Experimental",
  "Experimental",
  "S4.context-experimental",
  EXPERIMENTAL_SETTINGS,
);

/** Context settings in the same order as omp's Context settings tab. */
export const P7_CONTEXT_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  CONTEXT_GENERAL_SETTINGS,
  CONTEXT_COMPACTION_SETTINGS,
  CONTEXT_RULES_SETTINGS,
  CONTEXT_EXPERIMENTAL_SETTINGS,
];

/** Values used only to validate numeric choices rendered by the shared section control. */
export const P7_CONTEXT_NUMERIC_SETTINGS: readonly string[] = [
  "compaction.thresholdPercent",
  "compaction.thresholdTokens",
  "ttsr.repeatGap",
];
