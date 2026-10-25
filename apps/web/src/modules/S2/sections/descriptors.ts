import type { JsonValue } from "@omp-app/contracts";
import type {
  RowsSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { numberRangeWords, settingOptions, terminalOnlyDescription } from "../../S1/settings-kit";

/**
 * Keys, labels and defaults mirror omp v18.12.6's registered UI settings:
 * - edit/settings.ts (edit.*)
 * - tools/settings.ts (read.* and read.summarize.*)
 * - lsp/settings.ts (lsp.*)
 * - exec/settings.ts (bash.*, bashInterceptor.*, shellMinimizer.*)
 * - eval/settings.ts (eval.* and python.*)
 *
 * The S2.3 descriptions and live apply boundaries are checked against omp v18.9.1:
 * `packages/coding-agent/src/lsp/settings.ts`, `exec/settings.ts`, `eval/settings.ts`,
 * `sdk.ts:5068-5135`, and `main.ts:2549-2554`.
 * Source snapshot: https://github.com/can1357/oh-my-pi/tree/v18.12.6/packages/coding-agent/src
 */

const HOST_CONFIG = ["host.config"] as const;

function plainValue(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function validateBoolean(value: SettingValue): ValidationResult {
  return typeof plainValue(value) === "boolean"
    ? { valid: true }
    : { valid: false, code: "boolean", message: "Choose true or false." };
}

function validateEnum(values: readonly string[], value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  return typeof candidate === "string" && values.includes(candidate)
    ? { valid: true }
    : { valid: false, code: "enum", message: `Choose one of: ${values.join(", ")}.` };
}

function validateNumber(
  value: SettingValue,
  minimum: number,
  maximum: number,
  integer = true,
): ValidationResult {
  const candidate = plainValue(value);
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
}

function validatePath(value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  if (typeof candidate !== "string") {
    return { valid: false, code: "path", message: "Enter a path or leave it blank." };
  }
  return candidate.includes("\0")
    ? { valid: false, code: "path", message: "The path contains an invalid character." }
    : { valid: true };
}

function control(
  key: SettingControl["key"],
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: SettingControl["validate"],
  apply: SettingControl["apply"],
  options?: ScalarSettingControl["options"],
  description?: string,
): ScalarSettingControl {
  return {
    key,
    label,
    ...(description === undefined ? {} : { description }),
    kind,
    secret: false,
    validate,
    apply,
    ...(options === undefined ? {} : { options }),
  };
}

function booleanControl(
  key: SettingControl["key"],
  label: string,
  apply: SettingControl["apply"],
  description?: string,
): ScalarSettingControl {
  return control(key, label, "boolean", validateBoolean, apply, undefined, description);
}

function enumControl(
  key: SettingControl["key"],
  label: string,
  values: readonly string[],
  apply: SettingControl["apply"],
  description?: string,
): SettingControl {
  return control(
    key,
    label,
    "enum",
    (value) => validateEnum(values, value),
    apply,
    settingOptions(values),
    description,
  );
}

function numberControl(
  key: SettingControl["key"],
  label: string,
  minimum: number,
  maximum: number,
  apply: SettingControl["apply"],
  integer = true,
  description?: string,
): SettingControl {
  return control(
    key,
    label,
    "number",
    (value) => validateNumber(value, minimum, maximum, integer),
    apply,
    undefined,
    description,
  );
}

function durationControl(
  key: SettingControl["key"],
  label: string,
  maximum: number,
  apply: SettingControl["apply"],
  description?: string,
): SettingControl {
  return control(
    key,
    label,
    "duration",
    (value) => validateNumber(value, 0, maximum),
    apply,
    undefined,
    description,
  );
}

function pathControl(
  key: SettingControl["key"],
  label: string,
  apply: SettingControl["apply"],
  description?: string,
): SettingControl {
  return control(key, label, "path", validatePath, apply, undefined, description);
}

const BASH_PATTERN_APPROVALS = ["allow", "deny", "prompt"] as const;

/** Each rule is `{ match, approval }`; omp drops rules with an empty match or another approval. */
function validateBashPatterns(value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  const valid =
    Array.isArray(candidate) &&
    candidate.every(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        !Array.isArray(rule) &&
        typeof rule.match === "string" &&
        rule.match.trim().length > 0 &&
        BASH_PATTERN_APPROVALS.some((approval) => approval === rule.approval),
    );
  return valid
    ? { valid: true }
    : { valid: false, code: "rows", message: "Each rule needs a command pattern and an approval." };
}

/**
 * `bash.patterns`: ordered command approval rules, first match wins; `*` is the only wildcard
 * (omp v18.12.6 exec/settings.ts:136-147, tools/bash.ts:234-269).
 */
const bashPatternsControl: RowsSettingControl = {
  key: "bash.patterns",
  label: "Bash Approval Patterns",
  description:
    "Ordered command rules. Each rule has a match pattern and an approval action; the first matching rule wins, and * is the only wildcard.",
  kind: "rows",
  secret: false,
  fields: {
    match: { label: "Command pattern", kind: "text", placeholder: "git push *" },
    approval: {
      label: "Approval",
      kind: "enum",
      options: [
        { value: "prompt", label: "Ask first" },
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" },
      ],
    },
  },
  ordered: true,
  addLabel: "Add rule",
  emptyLabel: "No approval rules",
  validate: validateBashPatterns,
  apply: "live",
};

const filesEditing: readonly SettingControl[] = [
  enumControl(
    "edit.mode",
    "Edit Mode",
    ["apply_patch", "hashline", "patch", "replace", "sloppy"],
    "live",
    "Choose how omp changes files, such as with patches or direct replacements.",
  ),
  booleanControl(
    "edit.fuzzyMatch",
    "Fuzzy Match",
    "live",
    "Allow close matches when whitespace differs.",
  ),
  numberControl(
    "edit.fuzzyThreshold",
    "Fuzzy Match Threshold",
    0,
    1,
    "live",
    false,
    "Similarity threshold from 0 to 1 for accepting a close match.",
  ),
  booleanControl(
    "edit.streamingAbort",
    "Abort on Failed Preview",
    "live",
    "Stop an edit when its preview fails.",
  ),
  booleanControl(
    "edit.recoverInlineEdits",
    "Recover Inline Edit Payloads",
    "live",
    "Turn plain-text edit instructions into edit actions.",
  ),
  booleanControl(
    "edit.blockAutoGenerated",
    "Block Auto-Generated Files",
    "live",
    "Prevent changes to files that appear to be generated.",
  ),
  booleanControl(
    "edit.enforceSeenLines",
    "Enforce Seen-Line Guard",
    "live",
    "Reject edits to lines that were not fully shown in an earlier read or search.",
  ),
  booleanControl(
    "edit.blackbox.enabled",
    "Record Parse Regressions",
    "live",
    "Save the full file before and after an edit that causes a syntax error.",
  ),
  booleanControl(
    "edit.autoRepair.enabled",
    "Auto-Repair Parse Regressions",
    "live",
    "Ask a smaller model to repair an edit that causes a syntax error.",
  ),
];

const readToolResultPreviewControl: ScalarSettingControl = {
  ...booleanControl(
    "read.toolResultPreview",
    "Inline Read Previews",
    "live",
    terminalOnlyDescription(
      "Show read results inline in the transcript instead of as summary rows.",
    ),
  ),
  readOnly: {
    reason: "This preference only changes omp's terminal; the app does not use it.",
  },
};

const filesReading: readonly SettingControl[] = [
  booleanControl(
    "readLineNumbers",
    "Line Numbers",
    "live",
    "Show line numbers in read results by default.",
  ),
  numberControl(
    "read.defaultLimit",
    "Default Read Limit",
    1,
    100_000,
    "live",
    true,
    "Set how many lines are returned when a read request has no limit.",
  ),
  booleanControl(
    "read.renderMarkdown",
    "Markdown Previews",
    "live",
    "Format Markdown read results instead of showing plain text.",
  ),
  readToolResultPreviewControl,
];

const filesReadSummaries: readonly SettingControl[] = [
  booleanControl(
    "read.summarize.enabled",
    "Read Summaries",
    "live",
    "Show a structural summary when a read request has no selector.",
  ),
  booleanControl(
    "read.summarize.prose",
    "Prose Summaries",
    "live",
    "Show structural summaries for Markdown and plain-text files.",
  ),
  numberControl(
    "read.summarize.minBodyLines",
    "Read Summary Body Lines",
    0,
    100_000,
    "live",
    true,
    "Minimum number of lines in a block before a summary folds it.",
  ),
  numberControl(
    "read.summarize.minCommentLines",
    "Read Summary Comment Lines",
    0,
    100_000,
    "live",
    true,
    "Minimum number of lines in a block comment before a summary folds it.",
  ),
  numberControl(
    "read.summarize.minTotalLines",
    "Read Summary Minimum File Length",
    0,
    1_000_000,
    "live",
    true,
    "Show shorter files in full instead of as a structural summary.",
  ),
  numberControl(
    "read.summarize.unfoldUntil",
    "Read Summary Unfold Target",
    0,
    1_000_000,
    "live",
    true,
    "Keep expanding hidden sections until the summary reaches this many lines. Use 0 to keep them folded.",
  ),
  numberControl(
    "read.summarize.unfoldLimit",
    "Read Summary Unfold Ceiling",
    0,
    1_000_000,
    "live",
    true,
    "Set the maximum number of lines in a summary while hidden sections are expanded.",
  ),
];

const filesLsp: readonly SettingControl[] = [
  booleanControl(
    "lsp.enabled",
    "LSP",
    "live",
    "Use language tools to find definitions and references, show diagnostics, and rename symbols.",
  ),
  booleanControl(
    "lsp.lazy",
    "Lazy LSP Startup",
    "live",
    "Start language servers when first needed instead of when a chat opens.",
  ),
  booleanControl(
    "lsp.shared",
    "Shared Language Servers",
    "live",
    "Start language servers through the project's shared helper: each session gets its own server, and while another omp session in the project is running a stopped one stays warm for the next session; if the helper is unavailable each session uses a private server.",
  ),
  booleanControl(
    "lsp.formatOnWrite",
    "Format on Write",
    "live",
    "Format supported code files after writing them.",
  ),
  booleanControl(
    "lsp.diagnosticsOnWrite",
    "Diagnostics on Write",
    "live",
    "Show language-tool diagnostics after writing code files.",
  ),
  booleanControl(
    "lsp.diagnosticsOnEdit",
    "Diagnostics on Edit",
    "live",
    "Show language-tool diagnostics after editing code files.",
  ),
  booleanControl(
    "lsp.diagnosticsDeduplicate",
    "Deduplicate Diagnostics",
    "live",
    "Skip diagnostics already shown for a file and show only new or changed ones.",
  ),
  numberControl(
    "lsp.requestTimeout",
    "Request Timeout",
    0,
    3600,
    "live",
    true,
    "Seconds to wait for a language server's diagnostics, hover, and other answers when no timeout is set.",
  ),
];

const shellBash: readonly SettingControl[] = [
  booleanControl(
    "bash.enabled",
    "Bash",
    "live",
    "Allow shell commands to run through the Bash tool.",
  ),
  booleanControl(
    "bash.allowCompoundCommands",
    "Allow Compound Commands",
    "live",
    "Check each command joined with &&; unmatched commands use the usual approval rules.",
  ),
  booleanControl(
    "bash.autoBackground.enabled",
    "Bash Auto-Background",
    "live",
    "Run long commands in the background and deliver their results later.",
  ),
  booleanControl(
    "bash.gitGuard",
    "Git Guard",
    "live",
    "Block Git commands that could discard shared work, such as hard resets or restoring files outside a merge conflict.",
  ),
  bashPatternsControl,
  booleanControl(
    "bashInterceptor.enabled",
    "Bash Interceptor",
    "live",
    "Block shell commands that have dedicated tools.",
  ),
  enumControl(
    "bash.direnv",
    "direnv Auto-Load",
    ["auto", "off"],
    "live",
    "Load a repository's approved environment before running commands; never run an unapproved .envrc file.",
  ),
  durationControl(
    "bash.direnvLoadTimeoutMs",
    "direnv Load Timeout (ms)",
    600_000,
    "live",
    "Stop waiting for the repository environment after this many milliseconds; commands still run without it.",
  ),
  booleanControl(
    "shellMinimizer.enabled",
    "Shell Minimizer",
    "live",
    "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent.",
  ),
  enumControl(
    "shellMinimizer.sourceOutlineLevel",
    "Shell Minimizer Source Outline",
    ["default", "aggressive"],
    "live",
    "Choose how much source-code detail to keep when command output is shortened.",
  ),
];

const shellEvalRuntimes: readonly SettingControl[] = [
  booleanControl("eval.py", "Python Eval Backend", "live", "Allow evaluation code to run Python."),
  booleanControl(
    "eval.js",
    "JavaScript Eval Backend",
    "live",
    "Allow evaluation code to run JavaScript in omp's own runtime.",
  ),
  booleanControl(
    "eval.autoProvision",
    "Eval Environment Provisioning",
    "live",
    "Create the managed JavaScript environment the first time it is needed.",
  ),
  booleanControl(
    "eval.tools.enabled",
    "Eval-Defined Tools",
    "live",
    "Allow evaluation code to define tools that helper agents can use.",
  ),
  booleanControl(
    "eval.workpool.freshAgents",
    "Fresh Workpool Agents",
    "live",
    "Use a new helper for each work item instead of reusing helpers or batching items.",
  ),
  booleanControl(
    "eval.autoBackground.enabled",
    "Eval Auto-Background",
    "live",
    "Run long evaluation tasks in the background and deliver their results later.",
  ),
  enumControl(
    "python.kernelMode",
    "Python Kernel Mode",
    ["session", "per-call"],
    "live",
    "Keep one Python session for repeated evaluations, or start a fresh session for each call.",
  ),
  pathControl(
    "python.interpreter",
    "Python Interpreter",
    "live",
    "Choose a specific Python executable; when set, automatic discovery is skipped.",
  ),
];

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
  applyReport?: SettingsSectionDescriptor["applyReport"],
): SettingsSectionDescriptor {
  return {
    id,
    section: sectionName,
    title,
    inventory,
    controls,
    requires: [...HOST_CONFIG],
    ...(applyReport ? { applyReport } : {}),
  };
}

export const FILES_EDITING_SECTION = section(
  "S2.filesEditing",
  "files/Editing",
  "Editing",
  ["S5.files-editing"],
  filesEditing,
);
export const FILES_READING_SECTION = section(
  "S2.filesReading",
  "files/Reading",
  "Reading",
  ["S5.files-reading"],
  filesReading,
);
export const FILES_READ_SUMMARIES_SECTION = section(
  "S2.filesReadSummaries",
  "files/Read Summaries",
  "Read Summaries",
  ["S5.files-read-summaries"],
  filesReadSummaries,
);
export const FILES_LSP_SECTION = section(
  "S2.filesLsp",
  "files/LSP",
  "LSP",
  ["S5.files-lsp"],
  filesLsp,
  {
    note: "Language servers start when first needed if Lazy LSP Startup is on. Turning it off starts them in the background. Shared Language Servers affects new connections; a connected server keeps its current connection. Saving does not interrupt work already running.",
  },
);
export const SHELL_BASH_SECTION = section(
  "S2.shellBash",
  "shell/Bash",
  "Bash",
  ["S5.shell-bash"],
  shellBash,
  {
    note: "Changes apply to each new shell command. Saving does not interrupt a command already running.",
  },
);
export const SHELL_EVAL_RUNTIMES_SECTION = section(
  "S2.shellEvalRuntimes",
  "shell/Eval & Runtimes",
  "Eval and Runtimes",
  ["S5.shell-eval-runtimes"],
  shellEvalRuntimes,
  {
    note: "Python and JavaScript evaluations use these options when they run. Existing Python sessions keep running until they close. For parallel tasks, choose whether to start a new helper for every task.",
  },
);

export const S2_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  FILES_EDITING_SECTION,
  FILES_READING_SECTION,
  FILES_READ_SUMMARIES_SECTION,
  FILES_LSP_SECTION,
  SHELL_BASH_SECTION,
  SHELL_EVAL_RUNTIMES_SECTION,
];
