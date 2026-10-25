import type { JsonValue } from "@omp-app/contracts";
import type {
  ConfigSnapshot,
  MapSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValidationContext,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { numberRangeWords, settingOptions, terminalOnlyDescription } from "../../S1/settings-kit";

/**
 * Keys mirror omp v18.12.6's UI registrations in tools/settings.ts, tools/browser/settings.ts,
 * ida/settings.ts, task/settings.ts, goals/settings.ts, plan-mode/settings.ts and
 * extensibility/settings.ts. The worktree lifecycle keys follow `task/settings.ts:104-145`.
 * Per-key type/default citations are in `test/tasks/fixtures.ts`; ConfigStore provenance stays in
 * the typed S1-backed snapshots, with Tools citations in `../tools/policy.ts`.
 */

const HOST_CONFIG = ["host.config"] as const;

type Validator = (
  value: SettingValue,
  snapshot: ConfigSnapshot,
  context?: SettingValidationContext,
) => ValidationResult;
type UndescribedScalarSettingControl = Omit<ScalarSettingControl, "label" | "description">;

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

/** Choice labels `optionLabel` can't spell: file systems, acronyms and "xhigh". */
const S3_OPTION_LABELS: Readonly<Record<string, string>> = {
  apfs: "APFS",
  btrfs: "Btrfs",
  zfs: "ZFS",
  overlayfs: "OverlayFS",
  projfs: "ProjFS",
  rcopy: "Recursive copy",
  ai: "AI",
  xhigh: "Extra high",
  max: "Maximum",
  ultrafast: "Ultra-fast",
  "block-clone": "Block clone",
};

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
          message: `Enter ${numberRangeWords(integer, minimum, maximum)}.`,
        };
  };
}

function snapshotNumber(
  snapshot: ConfigSnapshot,
  key: string,
  context?: SettingValidationContext,
): number | undefined {
  const edit = context?.edits[key];
  if (edit !== undefined) {
    return !edit.secret && typeof edit.value === "number" ? edit.value : undefined;
  }
  const entry = snapshot.entries.find((candidate) => candidate.key === key);
  return entry && !entry.secret && typeof entry.value === "number" ? entry.value : undefined;
}

function relationalNumberValidator(
  _key: string,
  minimum: number,
  maximum: number,
  relation: (
    candidate: number,
    snapshot: ConfigSnapshot,
    context?: SettingValidationContext,
  ) => boolean,
  message: string,
): Validator {
  const base = numberValidator(minimum, maximum);
  return (value, snapshot, context) => {
    const result = base(value, snapshot);
    if (!result.valid) return result;
    const candidate = plain(value);
    if (typeof candidate !== "number") return { valid: false, code: "range", message };
    if (context?.phase === "stage") return { valid: true };
    return relation(candidate, snapshot, context)
      ? { valid: true }
      : { valid: false, code: "relationship", message };
  };
}

function absoluteWorktreeBaseValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return { valid: false, code: "path", message: "Enter an absolute path or leave it empty." };
  }
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    candidate.startsWith("\\\\") ||
    candidate === "~" ||
    candidate.startsWith("~/") ||
    candidate.startsWith("~\\") ||
    /^[A-Za-z]:[\\/]/.test(candidate)
  ) {
    return { valid: true };
  }
  return { valid: false, code: "path", message: "Enter an absolute path or leave it empty." };
}

function artifactLimitValidator(key: string): Validator {
  return relationalNumberValidator(
    key,
    0,
    1_048_576,
    (candidate, snapshot, context) => {
      const spill =
        key === "tools.artifactSpillThreshold"
          ? candidate
          : snapshotNumber(snapshot, "tools.artifactSpillThreshold", context);
      const tail =
        key === "tools.artifactTailBytes"
          ? candidate
          : snapshotNumber(snapshot, "tools.artifactTailBytes", context);
      const head =
        key === "tools.artifactHeadBytes"
          ? candidate
          : snapshotNumber(snapshot, "tools.artifactHeadBytes", context);
      return (
        spill === undefined || tail === undefined || head === undefined || head + tail <= spill
      );
    },
    "Artifact head and tail sizes must fit within the spill threshold.",
  );
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

const GOAL_CONTINUATION_MODES = ["interactive", "rpc"] as const;

function goalContinuationModesValidator(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (
    !Array.isArray(candidate) ||
    candidate.some(
      (item) =>
        typeof item !== "string" ||
        !GOAL_CONTINUATION_MODES.includes(item as "interactive" | "rpc"),
    )
  ) {
    return {
      valid: false,
      code: "enum",
      message:
        "Choose only interactive for omp's terminal, only rpc for the app and other hosts, or both.",
    };
  }
  return { valid: true };
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
  optionLabels: Readonly<Record<string, string>> = S3_OPTION_LABELS,
): UndescribedScalarSettingControl {
  return {
    key,
    kind,
    secret: false,
    validate,
    apply,
    ...(options === undefined ? {} : { options: settingOptions(options, optionLabels) }),
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
const duration = (
  key: string,
  maximum: number,
  apply: SettingControl["apply"] = "reload",
  minimum = 0,
) => control(key, "duration", apply, numberValidator(minimum, maximum));
const enumSetting = (
  key: string,
  values: readonly string[],
  apply: SettingControl["apply"] = "reload",
  optionLabels: Readonly<Record<string, string>> = S3_OPTION_LABELS,
) => control(key, "enum", apply, enumValidator(values), values, optionLabels);
const text = (
  key: string,
  kind: "text" | "path" = "text",
  apply: SettingControl["apply"] = "reload",
) => control(key, kind, apply, kind === "path" ? pathValidator : stringValidator);
const url = (key: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "text", apply, urlValidator);
const optionalUrl = (key: string, apply: SettingControl["apply"] = "reload") =>
  control(key, "text", apply, (value) => {
    if (plain(value) === "") return { valid: true };
    return urlValidator(value);
  });
function described(
  setting: UndescribedScalarSettingControl,
  label: string,
  description: string,
): ScalarSettingControl {
  return { ...setting, label, description };
}
const toolsAvailable: readonly SettingControl[] = [
  described(bool("todo.enabled"), "Todos", "Enable the todo tool for task tracking."),
  described(bool("glob.enabled"), "Glob", "Find files by matching their paths against patterns."),
  described(bool("grep.enabled"), "Grep", "Search file contents with regular expressions."),
  described(bool("astGrep.enabled"), "AST Grep", "Search source code by matching its syntax tree."),
  described(bool("astEdit.enabled"), "AST Edit", "Rewrite source code with syntax-aware patterns."),
  described(
    enumSetting("find.enabled", ["auto", "on", "off"], "live"),
    "Find (semantic grep)",
    "Search for files and line ranges with natural-language queries. Automatic mode uses the find tool only when a supported judge model is available.",
  ),
  described(
    bool("debug.enabled"),
    "Debug",
    "Attach to a compatible debugger and inspect running programs.",
  ),
  described(
    bool("launch.enabled"),
    "Services",
    "Run named shell services and monitor shared long-running project processes.",
  ),
  described(
    bool("speechgen.enabled"),
    "Speech Generation",
    "Create speech files with on-device or cloud speech synthesis.",
  ),
  described(
    bool("generate_image.enabled"),
    "Generate Image",
    "Create and edit images from text prompts.",
  ),
  described(
    bool("computer.enabled"),
    "Computer",
    "Automate the host desktop with screenshots, input, and accessibility controls.",
  ),
  described(
    bool("ratchet.enabled"),
    "Ratchet",
    "Enable the development hill-climb tool; it can also be turned on for one session.",
  ),
  described(
    bool("archive.enabled"),
    "Archive",
    "Read prompt history, recent projects, and summaries of past sessions.",
  ),
  described(
    bool("checkpoint.enabled"),
    "Checkpoint/Rewind",
    "Save and restore context checkpoints.",
  ),
  described(
    bool("fetch.enabled"),
    "Read URLs",
    "Allow the read tool to fetch and process web pages.",
  ),
  described(
    bool("vault.enabled"),
    "Obsidian Vault",
    "Read and edit Obsidian vault content through the Obsidian command-line tool.",
  ),
  described(
    bool("github.enabled"),
    "GitHub CLI",
    "Work with repositories, issues, pull requests, search, checkout, pushes, and GitHub Actions.",
  ),
  described(bool("web_search.enabled"), "Web Search", "Search the web for current information."),
  described(
    bool("security.enabled"),
    "Security",
    "Plan and run security scans and read their results.",
  ),
  described(bool("ask.enabled"), "Ask", "Ask the user an interactive question."),
  described(
    bool("browser.enabled"),
    "Browser",
    "Automate Chromium with scripted browser interactions.",
  ),
  described(
    bool("ida.enabled"),
    "IDA Pro",
    "Open executables in IDA Pro when an installation is available and enable the analysis tool.",
  ),
];

const toolsGrepBrowser: readonly SettingControl[] = [
  described(
    number("grep.contextBefore", 0, 100),
    "Grep Context Before (lines)",
    "Number of lines shown before each matching line.",
  ),
  described(
    number("grep.contextAfter", 0, 100),
    "Grep Context After (lines)",
    "Number of lines shown after each matching line.",
  ),
  described(
    optionalUrl("browser.cdpUrl", "live"),
    "Browser CDP URL",
    "HTTP debugging endpoint used to attach to an existing browser instead of launching one. Browser choices on a tool call take precedence.",
  ),
  described(
    bool("browser.relay", "live"),
    "Browser Relay",
    "Drive your own Chrome tabs through the browser relay. Install the extension once; the relay starts when needed and takes precedence over the browser debugging URL.",
  ),
  described(
    optionalUrl("browser.relayUrl", "live"),
    "Browser Relay URL",
    "Address of the browser relay service; the default is http://127.0.0.1:9224.",
  ),
  described(
    bool("browser.headless", "live"),
    "Headless Browser",
    "Launch new browsers without displaying their interface; turn this off to show it.",
  ),
  described(
    bool("browser.cmux", "live"),
    "cmux Browser",
    "Use a cmux web view for browser automation when a cmux socket is available.",
  ),
  described(
    bool("browser.tern", "live"),
    "Tern Browser",
    "Show browser tabs as picture-in-picture windows in a Tern pane when available; otherwise use Chromium.",
  ),
  described(
    bool("browser.freezeOnTurnEnd", "live"),
    "Freeze Browser Tabs on Turn End",
    "Pause omp-owned headless tabs when a turn ends to reduce CPU and GPU use; tabs resume on next use.",
  ),
  described(
    number("browser.idleCloseSec", 0, 86_400, "live"),
    "Browser Idle-Close Timeout (seconds)",
    "Close omp-owned headless tabs and Tern picture-in-picture windows after this many idle seconds. 0 means never; session cleanup still closes them.",
  ),
  described(
    text("browser.screenshotDir", "path", "live"),
    "Screenshot Directory",
    "Directory for saved screenshots. If unset, screenshots use a temporary file. Supports ~ and absolute paths.",
  ),
];

const toolsComputer: readonly SettingControl[] = [
  described(
    text("computer.display", "text", "live"),
    "Computer Display",
    "Which display to capture: the active window's display (active), every display (all), or one display by its native identifier.",
  ),
  described(
    number("computer.maxWidth", 1, 16_384, "live"),
    "Computer Screenshot Width (pixels)",
    "Maximum width of a screenshot.",
  ),
  described(
    number("computer.maxHeight", 1, 16_384, "live"),
    "Computer Screenshot Height (pixels)",
    "Maximum height of a screenshot.",
  ),
];

const toolsGithub: readonly SettingControl[] = [
  described(
    bool("github.cache.enabled"),
    "GitHub View Cache",
    "Cache rendered issue and pull-request views so repeated reads are faster.",
  ),
  described(
    control(
      "github.cache.softTtlSec",
      "duration",
      "live",
      relationalNumberValidator(
        "github.cache.softTtlSec",
        0,
        2_592_000,
        (candidate, snapshot, context) => {
          const hard = snapshotNumber(snapshot, "github.cache.hardTtlSec", context);
          return hard === undefined || candidate <= hard;
        },
        "GitHub cache soft TTL must not exceed the hard TTL.",
      ),
    ),
    "GitHub Cache Soft TTL (seconds)",
    "Return cached issue and pull-request views directly within this window. This app requires the soft TTL to stay at or below the hard TTL.",
  ),
  described(
    control(
      "github.cache.hardTtlSec",
      "duration",
      "live",
      relationalNumberValidator(
        "github.cache.hardTtlSec",
        0,
        31_536_000,
        (candidate, snapshot, context) => {
          const soft = snapshotNumber(snapshot, "github.cache.softTtlSec", context);
          return soft === undefined || candidate >= soft;
        },
        "GitHub cache hard TTL must not be below the soft TTL.",
      ),
    ),
    "GitHub Cache Hard TTL (seconds)",
    "After the soft window, serve cached output and refresh it in the background; after this window, discard it. This app requires the hard TTL to stay at or above the soft TTL.",
  ),
];

const toolsOutputLimits: readonly SettingControl[] = [
  described(
    control(
      "tools.artifactSpillThreshold",
      "number",
      "live",
      artifactLimitValidator("tools.artifactSpillThreshold"),
    ),
    "Artifact Spill Threshold (KB)",
    "Save tool output as an artifact when it exceeds this size; keep the tail inline. This app requires head and tail to fit within this spill threshold.",
  ),
  described(
    control(
      "tools.artifactTailBytes",
      "number",
      "live",
      artifactLimitValidator("tools.artifactTailBytes"),
    ),
    "Artifact Tail Size (KB)",
    "Amount of the output tail kept inline when the rest is saved as an artifact. This app requires head and tail to fit within the spill threshold.",
  ),
  described(
    control(
      "tools.artifactHeadBytes",
      "number",
      "live",
      artifactLimitValidator("tools.artifactHeadBytes"),
    ),
    "Artifact Head Size (KB)",
    "Amount of the output beginning kept inline alongside the tail; 0 keeps only the tail. This app requires head and tail to fit within the spill threshold.",
  ),
  described(
    number("tools.outputMaxColumns", 0, 65_536),
    "Output Line Byte Cap (bytes)",
    "Maximum bytes per line in streamed tool output and file reads; 0 disables the cap.",
  ),
  described(
    number("tools.artifactTailLines", 0, 1_000_000),
    "Artifact Tail Lines",
    "Maximum number of output lines kept inline when the rest is saved as an artifact.",
  ),
  described(
    number("tools.artifactMaxBytes", 0, 1_048_576),
    "Artifact File Cap (MB)",
    "Maximum size of an artifact file; 0 means no size limit.",
  ),
];

// omp v18.12.6 `packages/coding-agent/src/tools/settings.ts:875-878`: boolean, default false.
// omp v18.12.6 `packages/coding-agent/src/tools/settings.ts:888-891`: number, default 2.
// omp v18.12.6 `packages/coding-agent/src/tools/settings.ts:928-932`: boolean, default true.
// omp v18.12.6 `packages/coding-agent/src/tools/settings.ts:941-945`: number, default 100.
const toolsExecution: readonly SettingControl[] = [
  described(
    duration("images.questionTimeoutMs", 3_600_000, "live"),
    "Image Question Timeout (ms)",
    "Maximum time for a vision-model request used by image questions; 0 disables the timeout.",
  ),
  described(
    bool("tools.intentTracing"),
    "Intent Tracing",
    "Ask the agent to describe a tool call's intent before it runs.",
  ),
  described(
    bool("tools.abortOnFabricatedResult"),
    "Abort on Fabricated Tool Results",
    "Stop immediately if the model starts inventing a tool result instead of waiting for the real result.",
  ),
  described(
    bool("tools.speculativeExecution.enabled", "live"),
    "Experimental Speculative Execution",
    "Run only validated local reads speculatively; network requests, provider calls, and live file writes are excluded.",
  ),
  described(
    number("tools.speculativeExecution.maxInFlight", 1, 4, "live"),
    "Speculative Execution Concurrency",
    "Maximum number of validated local reads allowed to run before normal dispatch.",
  ),
  described(
    number("tools.maxTimeout", 0, 86_400),
    "Max Tool Timeout (seconds)",
    "Maximum timeout the agent can request for a tool; 0 means no limit.",
  ),
  described(
    bool("async.enabled", "live"),
    "Async Execution",
    "Enable asynchronous shell commands and background task execution.",
  ),
  described(
    number("async.maxJobs", 0, 100, "live"),
    "Maximum Concurrent Async Jobs",
    "Maximum number of asynchronous shell commands and background tasks that may run at once.",
  ),
];

const toolsExtensions: readonly SettingControl[] = [
  described(
    duration("extensionHandlers.toolCallTimeoutMs", 3_600_000, "live", 1),
    "Tool Call Handler Timeout (ms)",
    "How long an extension's tool-call handler may work before it is stopped. A value that is not above 0 uses 30,000 ms; time spent waiting for a dialog does not count.",
  ),
];

const toolsDeveloper: readonly SettingControl[] = [
  described(
    bool("dev.autoqa"),
    "Auto QA",
    "Report tool issues automatically. The first report asks for consent; denying it disables reporting until re-enabled.",
  ),
  described(
    url("dev.autoqaPush.endpoint", "live"),
    "Auto QA Push Endpoint",
    "Full URL that receives automatic tool issue reports.",
  ),
];

const toolsIdaPro: readonly SettingControl[] = [
  described(
    text("ida.python", "path", "live"),
    "IDA Python",
    "Python interpreter that can import IDA libraries; leave empty to detect one automatically.",
  ),
  described(
    text("ida.installDir", "path", "live"),
    "IDA Install Directory",
    "Directory containing IDA libraries; leave empty to detect an installation automatically.",
  ),
  described(
    number("ida.maxOpen", 1, 64, "live"),
    "IDA Max Open Databases",
    "Maximum IDA databases open at once; opening another saves and closes the least recently used idle one.",
  ),
  described(
    duration("ida.idleCloseSec", 86_400, "live"),
    "IDA Idle Close Timeout (seconds)",
    "Save and close IDA databases idle longer than this. 0 keeps them open.",
  ),
];

const toolsTodos: readonly SettingControl[] = [
  described(
    bool("todo.reminders"),
    "Todo Reminders",
    "Remind the agent to complete todo items before it stops.",
  ),
  described(
    number("todo.remindersMax", 0, 100),
    "Todo Reminder Limit",
    "Maximum number of reminders before giving up.",
  ),
  described(
    enumSetting("todo.eager", ["default", "preferred", "always"], "live"),
    "Create Todos Automatically",
    "Choose whether the agent decides, is encouraged, or is required to create a todo list after the first message.",
  ),
  described(
    number("tasks.todoClearDelay", -1, 86_400, "live"),
    "Todo Auto-Clear Delay (seconds)",
    terminalOnlyDescription(
      "How long completed todo items remain visible; -1 keeps them indefinitely.",
    ),
  ),
];

const tasksCommandsSkills: readonly SettingControl[] = [
  described(
    bool("skills.enableSkillCommands"),
    "Skill Commands",
    "Register skills as slash commands.",
  ),
  described(
    bool("commands.enableClaudeUser"),
    "Claude User Commands",
    "Load commands from the user's Claude command directory.",
  ),
  described(
    bool("commands.enableClaudeProject"),
    "Claude Project Commands",
    "Load commands from the project's Claude command directory.",
  ),
  described(
    bool("commands.enableOpencodeUser"),
    "OpenCode User Commands",
    "Load commands from the user's OpenCode command directory.",
  ),
  described(
    bool("commands.enableOpencodeProject"),
    "OpenCode Project Commands",
    "Load commands from the project's OpenCode command directory.",
  ),
];

const tasksIsolation: readonly SettingControl[] = [
  described(
    bool("task.isolation.enabled", "live"),
    "Allow Isolated Subagents",
    "Lets a task ask for its own isolated copy of the project; tasks that do not ask run in the shared checkout. Applies to tasks started after saving.",
  ),
  described(
    enumSetting(
      "isolation.backend",
      ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"],
      "live",
    ),
    "Isolation Backend",
    "Choose the method for future isolated task copies; available methods depend on the file system. Saving only updates configuration and does not create a copy.",
  ),
  described(
    bool("worktree.clone", "live"),
    "Clone New Worktrees",
    "Use copy-on-write clones for future managed project copies when supported. Saving does not create one.",
  ),
  described(
    bool("worktree.cleanSource", "live"),
    "Clean Source Checkout When Creating a Worktree",
    "Destructive: creating an isolated copy may reset tracked changes and remove untracked files from the source after copying them. Saving only updates configuration.",
  ),
  described(
    enumSetting("worktree.onStart", ["off", "ask", "create"], "restart"),
    "Worktree on Start",
    terminalOnlyDescription(
      "Whether fresh interactive sessions start in a new linked worktree. Saving only updates configuration.",
    ),
  ),
  described(
    enumSetting("worktree.onExit", ["keep", "ask", "remove"], "restart"),
    "Worktree on Exit",
    terminalOnlyDescription(
      "What to do on exit with worktrees created since omp started. Saving only updates configuration.",
    ),
  ),
  described(
    bool("task.isolation.apply", "live"),
    "Automatically Apply Isolated Task Changes",
    "Destructive: successful changes from an isolated task may be applied to the parent checkout automatically. Saving only updates configuration.",
  ),
  described(
    enumSetting("task.isolation.merge", ["patch", "branch"], "live"),
    "Isolation Merge Strategy",
    "Choose whether future isolated results are applied as patches or merged as branches. Saving only updates configuration.",
  ),
  described(
    enumSetting("task.isolation.commits", ["generic", "ai"], "live"),
    "Isolation Commit Message Style",
    "Choose generic or AI-written commit messages for future nested-repository changes. Saving only updates configuration and does not create a commit.",
  ),
  described(
    control("worktree.base", "path", "live", absoluteWorktreeBaseValidator),
    "Worktree Base Directory",
    "Choose where future omp-managed project copies are stored. Use an absolute path or a path beginning with ~; omp ignores bare relative paths. An unset value uses omp's default. Saving does not create or change a copy.",
  ),
];

const tasksModes: readonly SettingControl[] = [
  described(
    bool("goal.enabled", "session"),
    "Goal Mode",
    "Enable per-session goals and the goal tool.",
  ),
  described(
    bool("goal.statusInFooter", "live"),
    "Goal Status in Footer",
    terminalOnlyDescription(
      "Show the token budget alongside the goal indicator in the status line.",
    ),
  ),
  described(
    control("goal.continuationModes", "list", "live", goalContinuationModesValidator),
    "Goal Continuation Modes",
    "Enter interactive for omp's terminal, rpc for the app and other hosts, or both.",
  ),
  described(
    bool("title.refreshOnReplan", "live"),
    "Refresh Title on Replan",
    "Refresh generated session titles after todo replanning unless the user set the title.",
  ),
  described(
    enumSetting("title.generator", ["fork", "tiny"], "live", { fork: "Fork", tiny: "Tiny" }),
    "Title Generator",
    "Names an untitled session from the user's messages. Fork uses an extra request for a side turn on this session's model, reads its prompt cache, and adds the card icon. Tiny uses only the small title model and creates plain titles without a card.",
  ),
  described(
    bool("plan.enabled", "session"),
    "Plan Mode",
    "Enable read-only exploration and planning before changes are made.",
  ),
  described(
    bool("plan.defaultOnStartup", "restart"),
    "Start in Plan Mode",
    terminalOnlyDescription("Automatically enter plan mode at the start of each new session."),
  ),
  described(
    bool("plan.autosave", "live"),
    "Autosave Plans",
    "Save approved plans to disk automatically when plan mode completes. Used by omp's terminal and editor sessions only.",
  ),
  described(
    text("plan.autosaveDir", "path", "live"),
    "Autosave Directory",
    "Directory for saved plans. Supports ~ and relative paths; an empty value uses the project's default plans directory. Used by omp's terminal and editor sessions only.",
  ),
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
      options: settingOptions(
        ["inherit", "none", "auto", "default", "flex", "scale", "priority", "ultrafast"],
        {
          inherit: "Inherit",
          none: "None",
          auto: "Automatic",
          default: "Default",
          flex: "Flexible",
          scale: "Scale",
          priority: "Priority",
          ultrafast: "Ultra-fast",
        },
      ),
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
  described(
    enumSetting("task.eager", ["default", "preferred", "always"], "live"),
    "Prefer Task Delegation",
    "Choose how strongly the agent should delegate work to subagents.",
  ),
  described(
    bool("task.batch", "live"),
    "Batch Task Calls",
    "Use one task call to start one subagent per item, sharing context across the batch.",
  ),
  described(
    bool("task.structured", "live"),
    "Structured Task Results",
    "Expose structured task results validated through the yield tool.",
  ),
  described(
    bool("task.speculativeLaunch", "live"),
    "Speculative Task Launch",
    "Start each batch subagent as soon as its task is ready; stop it if the call fails validation or is blocked.",
  ),
  described(
    bool("task.enableEffort", "live"),
    "Per-Task Effort",
    "Allow each task call to choose a subagent's reasoning effort.",
  ),
  described(
    number("task.maxConcurrency", 0, 1_000, "live"),
    "Max Concurrent Tasks",
    "Maximum number of subagents that may run at once; 0 means unlimited.",
  ),
  described(
    bool("task.enableLsp", "live"),
    "LSP in Subagents",
    "Allow subagents to use language-server tools.",
  ),
  described(
    number("task.maxRecursionDepth", -1, 100, "live"),
    "Max Task Recursion Depth",
    "Maximum number of nested subagent levels; -1 means unlimited.",
  ),
  described(
    duration("task.maxRuntimeMs", 86_400_000, "live"),
    "Max Subagent Runtime (ms)",
    "Hard time limit for each subagent; 0 disables the limit.",
  ),
  described(
    bool("task.completionProbe", "session"),
    "Subagent Completion Probe",
    "Ask working subagents for occasional completion estimates in interactive sessions.",
  ),
  described(
    duration("task.agentIdleTtlMs", 86_400_000, "live"),
    "Agent Idle TTL (ms)",
    "How long an idle subagent remains in memory before it is parked; 0 keeps it live until exit.",
  ),
  described(
    number("task.softRequestBudget", 0, 100_000, "live"),
    "Soft Subagent Request Budget",
    "Ask a subagent to wrap up when it exceeds this request budget; 0 disables the guard.",
  ),
  described(
    bool("task.softRequestBudgetNotice", "live"),
    "Soft Request Budget Notice",
    "Send one wrap-up notice when a subagent crosses its soft request budget.",
  ),
  described(
    enumSetting("task.maxEffort", ["minimal", "low", "medium", "high", "xhigh", "max"], "live"),
    "Maximum Per-Spawn Effort",
    "Set the highest reasoning effort task calls may request for a subagent.",
  ),
  described(
    control("task.disabledAgents", "list", "live", stringArrayValidator),
    "Disabled Agents",
    "Prevent selected agent names from being used by future task and evaluation dispatches.",
  ),
  ...tasksSubagentMaps,
  described(
    bool("task.prewalk", "live"),
    "Generic Task Prewalk",
    "Start the bundled generic task agent on its resolved model, then hand off to the lower-cost role at its first edit.",
  ),
];

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return { id, section: sectionName, title, inventory, controls, requires: [...HOST_CONFIG] };
}

export const TOOLS_AVAILABLE_SECTION = section(
  "S3.toolsAvailable",
  "tools/Available Tools",
  "Available Tools",
  ["S5.tools-available-tools"],
  toolsAvailable,
);
export const TOOLS_GREP_BROWSER_SECTION = section(
  "S3.toolsGrepBrowser",
  "tools/Grep & Browser",
  "Grep and Browser",
  ["S5.tools-grep-browser"],
  toolsGrepBrowser,
);
export const TOOLS_COMPUTER_SECTION = section(
  "S3.toolsComputer",
  "tools/Computer",
  "Computer",
  ["S5.tools-computer"],
  toolsComputer,
);
export const TOOLS_GITHUB_SECTION = section(
  "S3.toolsGithub",
  "tools/GitHub",
  "GitHub",
  ["S5.tools-github"],
  toolsGithub,
);
export const TOOLS_OUTPUT_LIMITS_SECTION = section(
  "S3.toolsOutputLimits",
  "tools/Output Limits",
  "Output Limits",
  ["S5.tools-output-limits"],
  toolsOutputLimits,
);
export const TOOLS_EXECUTION_SECTION = section(
  "S3.toolsExecution",
  "tools/Execution",
  "Execution",
  ["S5.tools-execution"],
  toolsExecution,
);
export const TOOLS_EXTENSIONS_SECTION = section(
  "S3.toolsExtensions",
  "tools/Extensions",
  "Extensions",
  ["S5.tools-extensions"],
  toolsExtensions,
);
export const TOOLS_DEVELOPER_SECTION = section(
  "S3.toolsDeveloper",
  "tools/Developer",
  "Developer",
  ["S5.tools-developer"],
  toolsDeveloper,
);
export const TOOLS_IDA_PRO_SECTION = section(
  "S3.toolsIdaPro",
  "tools/IDA Pro",
  "IDA Pro",
  ["S5.tools-ida-pro"],
  toolsIdaPro,
);
export const TOOLS_TODOS_SECTION = section(
  "S3.toolsTodos",
  "tools/Todos",
  "Todos",
  ["S5.tools-todos"],
  toolsTodos,
);
export const TASKS_COMMANDS_SKILLS_SECTION = section(
  "S3.tasksCommandsSkills",
  "tasks/Commands & Skills",
  "Commands and Skills",
  ["S5.tasks-commands-skills"],
  tasksCommandsSkills,
);
export const TASKS_ISOLATION_SECTION = section(
  "S3.tasksIsolation",
  "tasks/Isolation",
  "Isolation",
  ["S5.tasks-isolation"],
  tasksIsolation,
);
export const TASKS_MODES_SECTION = section(
  "S3.tasksModes",
  "tasks/Modes",
  "Modes",
  ["S5.tasks-modes"],
  tasksModes,
);
export const TASKS_SUBAGENTS_SECTION = section(
  "S3.tasksSubagents",
  "tasks/Subagents",
  "Subagents",
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
