import type { JsonValue } from "@omp-app/contracts";
import type {
  RowsSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";

/**
 * Keys and labels mirror omp v18.6.1's registered UI settings:
 * - edit/settings.ts (edit.*)
 * - tools/settings.ts (read.* and read.summarize.*)
 * - lsp/settings.ts (lsp.*)
 * - exec/settings.ts (bash.*, bashInterceptor.*, shellMinimizer.*)
 * - eval/settings.ts (eval.* and python.*)
 *
 * Source snapshot: https://github.com/can1357/oh-my-pi/tree/v18.6.1/packages/coding-agent/src
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
        message: integer
          ? `Enter a whole number from ${minimum} to ${maximum}.`
          : `Enter a number from ${minimum} to ${maximum}.`,
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
): ScalarSettingControl {
  return {
    key,
    label,
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
): SettingControl {
  return control(key, label, "boolean", validateBoolean, apply);
}

function enumControl(
  key: SettingControl["key"],
  label: string,
  values: readonly string[],
  apply: SettingControl["apply"],
): SettingControl {
  return control(
    key,
    label,
    "enum",
    (value) => validateEnum(values, value),
    apply,
    values.map((value) => ({ value, label: value })),
  );
}

function numberControl(
  key: SettingControl["key"],
  label: string,
  minimum: number,
  maximum: number,
  apply: SettingControl["apply"],
  integer = true,
): SettingControl {
  return control(
    key,
    label,
    "number",
    (value) => validateNumber(value, minimum, maximum, integer),
    apply,
  );
}

function durationControl(
  key: SettingControl["key"],
  label: string,
  maximum: number,
  apply: SettingControl["apply"],
): SettingControl {
  return control(key, label, "duration", (value) => validateNumber(value, 0, maximum), apply);
}

function pathControl(
  key: SettingControl["key"],
  label: string,
  apply: SettingControl["apply"],
): SettingControl {
  return control(key, label, "path", validatePath, apply);
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
 * (omp v18.6.1 exec/settings.ts:120-131, tools/bash.ts:235-270).
 */
const bashPatternsControl: RowsSettingControl = {
  key: "bash.patterns",
  label: "Bash Approval Patterns",
  description:
    "Ordered rules for approving bash commands; the first matching rule wins. Use * as a wildcard.",
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
  apply: "reload",
};

const filesEditing: readonly SettingControl[] = [
  enumControl(
    "edit.mode",
    "Edit Mode",
    ["apply_patch", "hashline", "patch", "replace", "sloppy"],
    "reload",
  ),
  booleanControl("edit.fuzzyMatch", "Fuzzy Match", "reload"),
  numberControl("edit.fuzzyThreshold", "Fuzzy Match Threshold", 0, 1, "reload", false),
  booleanControl("edit.streamingAbort", "Abort on Failed Preview", "reload"),
  booleanControl("edit.recoverInlineEdits", "Recover Inline Edit Payloads", "reload"),
  booleanControl("edit.blockAutoGenerated", "Block Auto-Generated Files", "reload"),
  booleanControl("edit.enforceSeenLines", "Enforce Seen-Line Guard", "reload"),
  booleanControl("edit.blackbox.enabled", "Record Parse Regressions", "reload"),
  booleanControl("edit.autoRepair.enabled", "Auto-Repair Parse Regressions", "reload"),
];

const filesReading: readonly SettingControl[] = [
  booleanControl("readLineNumbers", "Line Numbers", "live"),
  numberControl("read.defaultLimit", "Default Read Limit", 1, 100_000, "live"),
  booleanControl("read.renderMarkdown", "Markdown Previews", "live"),
  booleanControl("read.toolResultPreview", "Inline Read Previews", "live"),
];

const filesReadSummaries: readonly SettingControl[] = [
  booleanControl("read.summarize.enabled", "Read Summaries", "live"),
  booleanControl("read.summarize.prose", "Prose Summaries", "live"),
  numberControl("read.summarize.minBodyLines", "Read Summary Body Lines", 0, 100_000, "live"),
  numberControl("read.summarize.minCommentLines", "Read Summary Comment Lines", 0, 100_000, "live"),
  numberControl(
    "read.summarize.minTotalLines",
    "Read Summary Minimum File Length",
    0,
    1_000_000,
    "live",
  ),
  numberControl("read.summarize.unfoldUntil", "Read Summary Unfold Target", 0, 1_000_000, "live"),
  numberControl("read.summarize.unfoldLimit", "Read Summary Unfold Ceiling", 0, 1_000_000, "live"),
];

const filesLsp: readonly SettingControl[] = [
  booleanControl("lsp.enabled", "LSP", "reload"),
  booleanControl("lsp.lazy", "Lazy LSP Startup", "reload"),
  booleanControl("lsp.shared", "Shared Language Servers", "restart"),
  booleanControl("lsp.formatOnWrite", "Format on Write", "reload"),
  booleanControl("lsp.diagnosticsOnWrite", "Diagnostics on Write", "reload"),
  booleanControl("lsp.diagnosticsOnEdit", "Diagnostics on Edit", "reload"),
  booleanControl("lsp.diagnosticsDeduplicate", "Deduplicate Diagnostics", "reload"),
];

const shellBash: readonly SettingControl[] = [
  booleanControl("bash.enabled", "Bash", "restart"),
  booleanControl("bash.allowCompoundCommands", "Allow Compound Commands", "reload"),
  booleanControl("bash.autoBackground.enabled", "Bash Auto-Background", "reload"),
  bashPatternsControl,
  booleanControl("bashInterceptor.enabled", "Bash Interceptor", "reload"),
  enumControl("bash.direnv", "direnv Auto-Load", ["auto", "off"], "restart"),
  durationControl("bash.direnvLoadTimeoutMs", "direnv Load Timeout (ms)", 600_000, "restart"),
  booleanControl("shellMinimizer.enabled", "Shell Minimizer", "reload"),
  enumControl(
    "shellMinimizer.sourceOutlineLevel",
    "Shell Minimizer Source Outline",
    ["default", "aggressive"],
    "reload",
  ),
];

const shellEvalRuntimes: readonly SettingControl[] = [
  booleanControl("eval.py", "Python Eval Backend", "reload"),
  booleanControl("eval.js", "JavaScript Eval Backend", "reload"),
  booleanControl("eval.autoProvision", "Eval Environment Provisioning", "reload"),
  booleanControl("eval.tools.enabled", "Eval-Defined Tools", "reload"),
  booleanControl("eval.workpool.freshAgents", "Fresh Workpool Agents", "restart"),
  booleanControl("eval.autoBackground.enabled", "Eval Auto-Background", "reload"),
  enumControl("python.kernelMode", "Python Kernel Mode", ["session", "per-call"], "restart"),
  pathControl("python.interpreter", "Python Interpreter", "restart"),
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

export const FILES_EDITING_SECTION = section(
  "S2.filesEditing",
  "files/Editing",
  "Files / Editing",
  ["S5.files-editing"],
  filesEditing,
);
export const FILES_READING_SECTION = section(
  "S2.filesReading",
  "files/Reading",
  "Files / Reading",
  ["S5.files-reading"],
  filesReading,
);
export const FILES_READ_SUMMARIES_SECTION = section(
  "S2.filesReadSummaries",
  "files/Read Summaries",
  "Files / Read Summaries",
  ["S5.files-read-summaries"],
  filesReadSummaries,
);
export const FILES_LSP_SECTION = section(
  "S2.filesLsp",
  "files/LSP",
  "Files / LSP",
  ["S5.files-lsp"],
  filesLsp,
);
export const SHELL_BASH_SECTION = section(
  "S2.shellBash",
  "shell/Bash",
  "Shell / Bash",
  ["S5.shell-bash"],
  shellBash,
);
export const SHELL_EVAL_RUNTIMES_SECTION = section(
  "S2.shellEvalRuntimes",
  "shell/Eval & Runtimes",
  "Shell / Eval & Runtimes",
  ["S5.shell-eval-runtimes"],
  shellEvalRuntimes,
);

export const S2_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  FILES_EDITING_SECTION,
  FILES_READING_SECTION,
  FILES_READ_SUMMARIES_SECTION,
  FILES_LSP_SECTION,
  SHELL_BASH_SECTION,
  SHELL_EVAL_RUNTIMES_SECTION,
];
