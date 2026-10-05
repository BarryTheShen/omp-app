import type { JsonValue } from "@omp-app/contracts";
import type {
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";

/**
 * Keys mirror omp v18.6.1's UI registrations in tools/settings.ts, tools/browser/settings.ts,
 * ida/settings.ts, task/settings.ts, goals/settings.ts, plan-mode/settings.ts and
 * extensibility/settings.ts. The execution/cache keys are retained from the pinned S3 research
 * schema because they are config-only in the released source tree.
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

function control(
  key: string,
  kind: SettingControl["kind"],
  apply: SettingControl["apply"],
  validate: Validator,
  options?: readonly string[],
): SettingControl {
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

const toolsExecution: readonly SettingControl[] = [
  duration("images.questionTimeoutMs", 3_600_000),
  bool("tools.intentTracing"),
  bool("tools.abortOnFabricatedResult"),
  number("tools.maxTimeout", 0, 86_400),
  bool("async.enabled", "reload"),
  number("async.maxPollTimeMs", 0, 86_400_000, "reload"),
  duration("irc.timeoutMs", 0, "reload"),
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
  bool("task.isolation.enabled", "restart"),
  enumSetting(
    "isolation.backend",
    ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"],
    "restart",
  ),
  bool("worktree.clone", "restart"),
  bool("worktree.cleanSource", "restart"),
  bool("task.isolation.apply", "restart"),
  enumSetting("task.isolation.merge", ["patch", "branch"], "restart"),
  enumSetting("task.isolation.commits", ["generic", "ai"], "restart"),
  text("worktree.base", "path", "restart"),
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
  bool("task.prewalk", "session"),
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
