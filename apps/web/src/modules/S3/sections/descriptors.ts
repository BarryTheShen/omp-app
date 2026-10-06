import type { JsonValue } from "@omp-app/contracts";
import type {
  MapSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";

/**
 * Keys mirror omp v18.6.1's UI registrations in tools/settings.ts, tools/browser/settings.ts,
 * ida/settings.ts, task/settings.ts, goals/settings.ts, plan-mode/settings.ts and
 * extensibility/settings.ts. Per-key type/default citations are in `test/tasks/fixtures.ts`;
 * ConfigStore provenance stays in the typed S1-backed snapshots, with Tools citations in
 * `../tools/policy.ts`.
 */

const HOST_CONFIG = ["host.config"] as const;

type Validator = (value: SettingValue) => ValidationResult;

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function labelFor(key: string): string {
  const segment = key.split(".").at(-1) ?? key;
  return segment
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function booleanValidator(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : { valid: false, code: "boolean", message: "Choose true or false." };
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
          message: integer
            ? `Enter a whole number from ${minimum} to ${maximum}.`
            : `Enter a number from ${minimum} to ${maximum}.`,
        };
  };
}
function enumValidator(values: readonly string[]): Validator {
  return (value) =>
    typeof plain(value) === "string" && values.includes(plain(value) as string)
      ? { valid: true }
      : { valid: false, code: "enum", message: `Choose one of: ${values.join(", ")}.` };
}

function stringValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && !candidate.includes("\0")
    ? { valid: true }
    : { valid: false, code: "text", message: "Enter text without control characters." };
}

function urlValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return { valid: false, code: "url", message: "Enter a valid URL." };
  }
  try {
    new URL(candidate);
    return { valid: true };
  } catch {
    return { valid: false, code: "url", message: "Enter a valid URL." };
  }
}

function pathValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && !candidate.includes("\0")
    ? { valid: true }
    : { valid: false, code: "path", message: "Enter a valid path." };
}

function arrayValidator(value: SettingValue): ValidationResult {
  return Array.isArray(plain(value))
    ? { valid: true }
    : { valid: false, code: "array", message: "Enter a list." };
}
function stringArrayValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (!Array.isArray(candidate)) {
    return { valid: false, code: "array", message: "Enter a list of agent names." };
  }
  for (const item of candidate) {
    if (typeof item !== "string") {
      return { valid: false, code: "array", message: "Enter a list of agent names." };
    }
  }
  return { valid: true };
}

function modelOverridesValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (
    candidate === undefined ||
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return { valid: false, code: "map", message: "Enter model selectors by agent." };
  }
  for (const model of Object.values(candidate)) {
    if (typeof model === "string") continue;
    if (!Array.isArray(model)) {
      return {
        valid: false,
        code: "map",
        message: "Each agent needs a model selector or model list.",
      };
    }
    for (const selector of model) {
      if (typeof selector !== "string") {
        return {
          valid: false,
          code: "map",
          message: "Each agent needs a model selector or model list.",
        };
      }
    }
  }
  return { valid: true };
}

function serviceTierOverridesValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (
    candidate === undefined ||
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return { valid: false, code: "map", message: "Enter service tiers by agent." };
  }
  for (const tier of Object.values(candidate)) {
    if (
      tier !== "inherit" &&
      tier !== "none" &&
      tier !== "auto" &&
      tier !== "default" &&
      tier !== "flex" &&
      tier !== "scale" &&
      tier !== "priority" &&
      tier !== "ultrafast"
    ) {
      return {
        valid: false,
        code: "map",
        message: "Choose a supported service tier for each agent.",
      };
    }
  }
  return { valid: true };
}

function compactionThresholdOverridesValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (
    candidate === undefined ||
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return { valid: false, code: "map", message: "Enter compaction thresholds by agent." };
  }
  for (const threshold of Object.values(candidate)) {
    if (threshold === null) continue;
    if (typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0) continue;
    if (typeof threshold === "string") {
      const match = /^(\d+(?:\.\d+)?)%$/.exec(threshold.trim());
      const percent = match ? Number(match[1]) : Number.NaN;
      if (percent > 0 && percent <= 100) continue;
    }
    return {
      valid: false,
      code: "map",
      message: "Use a positive whole token count or a percentage from 0 to 100 for each agent.",
    };
  }
  return { valid: true };
}

function agentOverrideMapValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (
    candidate === undefined ||
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return { valid: false, code: "map", message: "Enter agent overrides as name and value pairs." };
  }
  for (const override of Object.values(candidate)) {
    if (typeof override !== "string") {
      return { valid: false, code: "map", message: "Enter text for each agent override." };
    }
  }
  return { valid: true };
}

function control(
  key: string,
  kind: ScalarSettingControl["kind"],
  apply: SettingControl["apply"],
  validate: Validator,
  options?: readonly string[],
): ScalarSettingControl {
  return {
    key,
    label: labelFor(key),
    kind,
    secret: false,
    validate,
    apply,
    ...(options === undefined
      ? {}
      : { options: options.map((value) => ({ value, label: value })) }),
  };
}

const bool = (key: string, apply: SettingControl["apply"] = "live") =>
  control(key, "boolean", apply, booleanValidator);
const number = (
  key: string,
  minimum: number,
  maximum: number,
  apply: SettingControl["apply"] = "live",
  integer = true,
) => control(key, "number", apply, numberValidator(minimum, maximum, integer));
const duration = (key: string, maximum: number, apply: SettingControl["apply"] = "reload") =>
  control(key, "duration", apply, numberValidator(0, maximum));
const enumSetting = (
  key: string,
  values: readonly string[],
  apply: SettingControl["apply"] = "reload",
) => control(key, "enum", apply, enumValidator(values), values);
const text = (
  key: string,
  kind: "text" | "path" = "text",
  apply: SettingControl["apply"] = "reload",
) => control(key, kind, apply, kind === "path" ? pathValidator : stringValidator);
const url = (key: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "text", apply, urlValidator);
const array = (key: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "list", apply, arrayValidator);
function described(setting: SettingControl, label: string, description: string): SettingControl {
  return { ...setting, label, description };
}

const toolsAvailable: readonly SettingControl[] = [
  bool("todo.enabled"),
  bool("glob.enabled"),
  bool("grep.enabled"),
  bool("astGrep.enabled"),
  bool("astEdit.enabled"),
  enumSetting("find.enabled", ["auto", "on", "off"]),
  bool("debug.enabled"),
  bool("launch.enabled"),
  bool("speechgen.enabled"),
  bool("generate_image.enabled"),
  bool("computer.enabled"),
  bool("ratchet.enabled"),
  bool("archive.enabled"),
  bool("checkpoint.enabled"),
  bool("fetch.enabled"),
  bool("vault.enabled"),
  bool("github.enabled"),
  bool("web_search.enabled"),
  bool("security.enabled"),
  bool("ask.enabled"),
  bool("browser.enabled"),
  bool("ida.enabled"),
];

const toolsGrepBrowser: readonly SettingControl[] = [
  number("grep.contextBefore", 0, 100),
  number("grep.contextAfter", 0, 100),
  url("browser.cdpUrl"),
  bool("browser.relay", "reload"),
  url("browser.relayUrl"),
  bool("browser.headless", "restart"),
  bool("browser.cmux", "restart"),
  bool("browser.tern", "restart"),
  bool("browser.freezeOnTurnEnd", "live"),
  number("browser.idleCloseSec", 0, 86_400, "live"),
  text("browser.screenshotDir", "path"),
];

const toolsComputer: readonly SettingControl[] = [
  text("computer.display", "text", "restart"),
  number("computer.maxWidth", 1, 16_384, "restart"),
  number("computer.maxHeight", 1, 16_384, "restart"),
];

const toolsGithub: readonly SettingControl[] = [
  bool("github.cache.enabled"),
  duration("github.cache.softTtlSec", 2_592_000),
  duration("github.cache.hardTtlSec", 31_536_000),
];

const toolsOutputLimits: readonly SettingControl[] = [
  number("tools.artifactSpillThreshold", 0, 1_048_576),
  number("tools.artifactTailBytes", 0, 1_048_576),
  number("tools.artifactHeadBytes", 0, 1_048_576),
  number("tools.outputMaxColumns", 0, 65_536),
  number("tools.artifactTailLines", 0, 1_000_000),
  number("tools.artifactMaxBytes", 0, 1_048_576),
];

// omp v18.6.1 `packages/coding-agent/src/tools/settings.ts:839-842`: boolean, default false.
// omp v18.6.1 `packages/coding-agent/src/tools/settings.ts:852-855`: number, default 2.
// omp v18.6.1 `packages/coding-agent/src/tools/settings.ts:892-896`: boolean, default true.
// omp v18.6.1 `packages/coding-agent/src/tools/settings.ts:905-909`: number, default 100.
const toolsExecution: readonly SettingControl[] = [
  duration("images.questionTimeoutMs", 3_600_000),
  bool("tools.intentTracing"),
  bool("tools.abortOnFabricatedResult"),
  bool("tools.speculativeExecution.enabled", "reload"),
  number("tools.speculativeExecution.maxInFlight", 1, 4, "reload"),
  number("tools.maxTimeout", 0, 86_400),
  // omp v18.6.1 reconciles this session tool gate live (`tools/settings.ts:1014-1045`).
  bool("async.enabled", "live"),
  number("async.maxJobs", 0, 100_000, "reload"),
];

const toolsExtensions: readonly SettingControl[] = [
  duration("extensionHandlers.toolCallTimeoutMs", 3_600_000),
];

const toolsDeveloper: readonly SettingControl[] = [
  bool("dev.autoqa"),
  url("dev.autoqaPush.endpoint"),
];

const toolsIdaPro: readonly SettingControl[] = [
  text("ida.python", "path", "restart"),
  text("ida.installDir", "path", "restart"),
  number("ida.maxOpen", 1, 64, "restart"),
  duration("ida.idleCloseSec", 86_400, "restart"),
];

const toolsTodos: readonly SettingControl[] = [
  bool("todo.reminders"),
  number("todo.remindersMax", 0, 100),
  enumSetting("todo.eager", ["default", "preferred", "always"]),
  number("tasks.todoClearDelay", -1, 86_400, "live"),
];

const tasksCommandsSkills: readonly SettingControl[] = [
  bool("skills.enableSkillCommands"),
  bool("commands.enableClaudeUser"),
  bool("commands.enableClaudeProject"),
  bool("commands.enableOpencodeUser"),
  bool("commands.enableOpencodeProject"),
];

const tasksIsolation: readonly SettingControl[] = [
  described(
    bool("task.isolation.enabled", "restart"),
    "Isolate Subagents",
    "Run subagents in an isolated copy of the checkout. Saving this preference changes configuration only; it does not create or alter a worktree.",
  ),
  described(
    enumSetting(
      "isolation.backend",
      ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"],
      "restart",
    ),
    "Isolation Backend",
    "Choose the backend for future isolated task workspaces. Saving this preference does not create or alter a worktree.",
  ),
  described(
    bool("worktree.clone", "restart"),
    "Clone New Worktrees",
    "Use copy-on-write clones for future managed worktrees when supported. Saving this preference does not create a worktree.",
  ),
  described(
    bool("worktree.cleanSource", "restart"),
    "Clean Source Checkout When Creating a Worktree",
    "Destructive: `/wt` may reset tracked changes and remove untracked files from the source checkout after copying them. Saving only updates configuration; it does not clean the checkout.",
  ),
  described(
    bool("task.isolation.apply", "restart"),
    "Automatically Apply Isolated Task Changes",
    "Destructive: successful isolated task changes may be applied to the parent checkout automatically. Saving only updates configuration; it does not apply task changes.",
  ),
  described(
    enumSetting("task.isolation.merge", ["patch", "branch"], "restart"),
    "Isolation Merge Strategy",
    "Choose patch application or branch merging for future isolated task results. Saving only updates configuration; it does not create or merge a branch.",
  ),
  described(
    enumSetting("task.isolation.commits", ["generic", "ai"], "restart"),
    "Isolation Commit Message Style",
    "Choose generic or AI-generated commit messages for future nested repository changes. Saving only updates configuration; it does not create a commit.",
  ),
  described(
    text("worktree.base", "path", "restart"),
    "Worktree Base Directory",
    "Choose where future omp-managed worktrees are stored. An unset value uses omp's default directory. Saving only updates configuration; it does not create or alter a worktree.",
  ),
];

const tasksModes: readonly SettingControl[] = [
  bool("goal.enabled", "session"),
  bool("goal.statusInFooter", "live"),
  array("goal.continuationModes", "session"),
  bool("title.refreshOnReplan", "live"),
  bool("plan.enabled", "session"),
  bool("plan.defaultOnStartup", "restart"),
  bool("plan.autosave", "reload"),
  text("plan.autosaveDir", "path", "reload"),
];

const tasksSubagentMaps: readonly MapSettingControl[] = [
  {
    key: "task.agentModelOverrides",
    label: "Agent Model Overrides",
    description: "Set one model selector or an ordered model preference list for each agent.",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    keyPlaceholder: "Agent name",
    value: {
      label: "Model selector",
      kind: "list",
      placeholder: "provider/model, provider/model",
      collapseSingle: true,
    },
    addLabel: "Add model override",
    emptyLabel: "No per-agent model overrides",
    validate: modelOverridesValidator,
    apply: "live",
  },
  {
    key: "task.agentServiceTierOverrides",
    label: "Agent Service Tier Overrides",
    description:
      "Choose the service tier for each agent; inherit follows the session's current tier.",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    keyPlaceholder: "Agent name",
    value: {
      label: "Service tier",
      kind: "enum",
      options: [
        { value: "inherit", label: "Inherit" },
        { value: "none", label: "None" },
        { value: "auto", label: "Auto" },
        { value: "default", label: "Default" },
        { value: "flex", label: "Flex" },
        { value: "scale", label: "Scale" },
        { value: "priority", label: "Priority" },
        { value: "ultrafast", label: "Ultrafast" },
      ],
    },
    addLabel: "Add service tier",
    emptyLabel: "No per-agent service tier overrides",
    validate: serviceTierOverridesValidator,
    apply: "live",
  },
  {
    key: "task.agentCompactionThresholdOverrides",
    label: "Agent Compaction Threshold Overrides",
    description: "Set a token count or percentage threshold for each agent.",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    keyPlaceholder: "Agent name",
    value: { label: "Token count or percentage", kind: "text", placeholder: "90000 or 80%" },
    addLabel: "Add compaction threshold",
    emptyLabel: "No per-agent compaction overrides",
    validate: compactionThresholdOverridesValidator,
    apply: "live",
    readOnly: {
      reason: "This setting accepts token counts or percentages; change it in omp's settings file.",
    },
  },
  {
    key: "task.agentPrewalk",
    label: "Agent Prewalk Overrides",
    description: "Choose whether an agent hands off to a cheaper model at its first edit.",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    keyPlaceholder: "Agent name",
    value: { label: "Prewalk override", kind: "text", placeholder: "on, off, or a model selector" },
    addLabel: "Add prewalk override",
    emptyLabel: "No per-agent prewalk overrides",
    validate: agentOverrideMapValidator,
    apply: "live",
  },
  {
    key: "task.agentAdvisor",
    label: "Agent Advisor Overrides",
    description: "Enable or disable an advisor for an agent, or choose its model.",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    keyPlaceholder: "Agent name",
    value: { label: "Advisor override", kind: "text", placeholder: "on, off, or a model selector" },
    addLabel: "Add advisor override",
    emptyLabel: "No per-agent advisor overrides",
    validate: agentOverrideMapValidator,
    apply: "live",
  },
];

const tasksSubagents: readonly SettingControl[] = [
  enumSetting("task.eager", ["default", "preferred", "always"], "session"),
  bool("task.batch", "reload"),
  bool("task.speculativeLaunch", "session"),
  bool("task.enableEffort", "reload"),
  number("task.maxConcurrency", 0, 1_000, "reload"),
  bool("task.enableLsp", "reload"),
  number("task.maxRecursionDepth", -1, 100, "reload"),
  duration("task.maxRuntimeMs", 86_400_000, "session"),
  bool("task.completionProbe", "session"),
  duration("task.agentIdleTtlMs", 86_400_000, "live"),
  number("task.softRequestBudget", 0, 100_000, "session"),
  bool("task.softRequestBudgetNotice", "session"),
  enumSetting("task.maxEffort", ["minimal", "low", "medium", "high", "xhigh", "max"], "session"),
  described(
    control("task.disabledAgents", "list", "live", stringArrayValidator),
    "Disabled Agents",
    "Prevent selected agent names from being used by future task and eval dispatches.",
  ),
  ...tasksSubagentMaps,
  bool("task.prewalk", "session"),
  described(
    bool("task.showResolvedModelBadge", "live"),
    "Show Resolved Model Badge",
    "Display the model actually used by each subagent in the task status line.",
  ),
];

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return {
    id,
    section: sectionName,
    title: sectionName.replace("/", " / "),
    inventory,
    controls,
    requires: [...HOST_CONFIG],
  };
}

export const TOOLS_AVAILABLE_SECTION = section(
  "S3.toolsAvailable",
  "tools/Available Tools",
  ["S5.tools-available-tools"],
  toolsAvailable,
);
export const TOOLS_GREP_BROWSER_SECTION = section(
  "S3.toolsGrepBrowser",
  "tools/Grep & Browser",
  ["S5.tools-grep-browser"],
  toolsGrepBrowser,
);
export const TOOLS_COMPUTER_SECTION = section(
  "S3.toolsComputer",
  "tools/Computer",
  ["S5.tools-computer"],
  toolsComputer,
);
export const TOOLS_GITHUB_SECTION = section(
  "S3.toolsGithub",
  "tools/GitHub",
  ["S5.tools-github"],
  toolsGithub,
);
export const TOOLS_OUTPUT_LIMITS_SECTION = section(
  "S3.toolsOutputLimits",
  "tools/Output Limits",
  ["S5.tools-output-limits"],
  toolsOutputLimits,
);
export const TOOLS_EXECUTION_SECTION = section(
  "S3.toolsExecution",
  "tools/Execution",
  ["S5.tools-execution"],
  toolsExecution,
);
export const TOOLS_EXTENSIONS_SECTION = section(
  "S3.toolsExtensions",
  "tools/Extensions",
  ["S5.tools-extensions"],
  toolsExtensions,
);
export const TOOLS_DEVELOPER_SECTION = section(
  "S3.toolsDeveloper",
  "tools/Developer",
  ["S5.tools-developer"],
  toolsDeveloper,
);
export const TOOLS_IDA_PRO_SECTION = section(
  "S3.toolsIdaPro",
  "tools/IDA Pro",
  ["S5.tools-ida-pro"],
  toolsIdaPro,
);
export const TOOLS_TODOS_SECTION = section(
  "S3.toolsTodos",
  "tools/Todos",
  ["S5.tools-todos"],
  toolsTodos,
);
export const TASKS_COMMANDS_SKILLS_SECTION = section(
  "S3.tasksCommandsSkills",
  "tasks/Commands & Skills",
  ["S5.tasks-commands-skills"],
  tasksCommandsSkills,
);
export const TASKS_ISOLATION_SECTION = section(
  "S3.tasksIsolation",
  "tasks/Isolation",
  ["S5.tasks-isolation"],
  tasksIsolation,
);
export const TASKS_MODES_SECTION = section(
  "S3.tasksModes",
  "tasks/Modes",
  ["S5.tasks-modes"],
  tasksModes,
);
export const TASKS_SUBAGENTS_SECTION = section(
  "S3.tasksSubagents",
  "tasks/Subagents",
  ["S5.tasks-subagents"],
  tasksSubagents,
);

export const S3_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  TOOLS_AVAILABLE_SECTION,
  TOOLS_GREP_BROWSER_SECTION,
  TOOLS_COMPUTER_SECTION,
  TOOLS_GITHUB_SECTION,
  TOOLS_OUTPUT_LIMITS_SECTION,
  TOOLS_EXECUTION_SECTION,
  TOOLS_EXTENSIONS_SECTION,
  TOOLS_DEVELOPER_SECTION,
  TOOLS_IDA_PRO_SECTION,
  TOOLS_TODOS_SECTION,
  TASKS_COMMANDS_SKILLS_SECTION,
  TASKS_ISOLATION_SECTION,
  TASKS_MODES_SECTION,
  TASKS_SUBAGENTS_SECTION,
];
