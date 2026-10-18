import type { CapabilityKey, JsonValue } from "@omp-app/contracts";
import type {
  MapSettingControl,
  ScalarSettingControl,
  SettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../settings-kit";
import { numberRangeWords, settingOptions, terminalOnlyDescription } from "../settings-kit";

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];
export const TOOL_APPROVAL_POLICY_VALUES = ["allow", "prompt", "deny"] as const;

const TOOL_APPROVAL_POLICY_LABELS = {
  allow: "Allow",
  prompt: "Ask first",
  deny: "Deny",
} as const;

const TOOL_APPROVAL_POLICY_OPTIONS: readonly SettingOption[] = TOOL_APPROVAL_POLICY_VALUES.map(
  (value) => ({
    value,
    label: TOOL_APPROVAL_POLICY_LABELS[value],
  }),
);

type EnumLabelMap = Readonly<Record<string, string>>;

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function invalid(code: string, message: string): ValidationResult {
  return { valid: false, code, message };
}

function validateBoolean(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : invalid("boolean", "Choose true or false.");
}

function validateEnum(values: readonly string[]) {
  return (value: SettingValue): ValidationResult => {
    const candidate = plain(value);
    return typeof candidate === "string" && values.includes(candidate)
      ? { valid: true }
      : invalid("enum", `Choose one of: ${values.join(", ")}.`);
  };
}

function validateNumber(minimum: number, maximum: number, integer = false) {
  return (value: SettingValue): ValidationResult => {
    const candidate = plain(value);
    const valid =
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= minimum &&
      candidate <= maximum &&
      (!integer || Number.isInteger(candidate));
    return valid
      ? { valid: true }
      : invalid("range", `Enter ${numberRangeWords(integer, minimum, maximum)}.`);
  };
}

function validateString(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && !candidate.includes("\0")
    ? { valid: true }
    : invalid("text", "Enter text without NUL characters.");
}

function validateUrl(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return invalid("url", "Enter a valid URL.");
  }
  if (candidate === "") return { valid: true };
  try {
    const url = new URL(candidate);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    const secureTransport = url.protocol === "https:" || (url.protocol === "http:" && local);
    const hasNoCredentialsOrFragment = !url.username && !url.password && !url.search && !url.hash;
    return secureTransport && hasNoCredentialsOrFragment
      ? { valid: true }
      : invalid(
          "url",
          "Use https://, or http:// for localhost only, without credentials or a fragment.",
        );
  } catch {
    return invalid("url", "Enter a valid URL.");
  }
}

function validateRelayUrl(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return invalid("url", "Enter a valid relay URL.");
  }
  try {
    const url = new URL(candidate);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    const secureTransport = url.protocol === "wss:" || (url.protocol === "ws:" && local);
    const isOriginOnly =
      url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
    return secureTransport && isOriginOnly
      ? { valid: true }
      : invalid(
          "url",
          "Use wss://, or ws:// for localhost only, without credentials, a path, or a fragment.",
        );
  } catch {
    return invalid("url", "Enter a valid relay URL.");
  }
}
function control(
  key: SettingControl["key"],
  label: string,
  kind: ScalarSettingControl["kind"],
  apply: SettingControl["apply"],
  validate: SettingControl["validate"],
  options?: readonly SettingOption[],
  description?: string,
): ScalarSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    apply,
    validate,
    ...(options === undefined ? {} : { options }),
    ...(description === undefined ? {} : { description }),
  };
}

function booleanControl(
  key: string,
  label: string,
  apply: SettingControl["apply"] = "live",
  description?: string,
): ScalarSettingControl {
  return control(key, label, "boolean", apply, validateBoolean, undefined, description);
}

function enumControl(
  key: string,
  label: string,
  values: readonly string[],
  apply: SettingControl["apply"] = "live",
  labels: EnumLabelMap = {},
  description?: string,
): ScalarSettingControl {
  return control(
    key,
    label,
    "enum",
    apply,
    validateEnum(values),
    settingOptions(values, labels),
    description,
  );
}

function numberControl(
  key: string,
  label: string,
  minimum: number,
  maximum: number,
  apply: SettingControl["apply"] = "live",
  integer = false,
  description?: string,
): ScalarSettingControl {
  return control(
    key,
    label,
    "number",
    apply,
    validateNumber(minimum, maximum, integer),
    undefined,
    description,
  );
}

function textControl(
  key: string,
  label: string,
  apply: SettingControl["apply"] = "live",
  description?: string,
): ScalarSettingControl {
  return control(key, label, "text", apply, validateString, undefined, description);
}

function urlControl(
  key: string,
  label: string,
  validate: SettingControl["validate"],
  description?: string,
): ScalarSettingControl {
  return control(key, label, "text", "live", validate, undefined, description);
}

function validateApprovalPolicies(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return invalid("map", "Enter a map of tool names to approval policies.");
  }
  for (const policy of Object.values(candidate)) {
    if (
      typeof policy !== "string" ||
      !TOOL_APPROVAL_POLICY_VALUES.some((allowed) => allowed === policy)
    ) {
      return invalid("policy", "Choose Allow, Prompt, or Deny for every tool.");
    }
  }
  return { valid: true };
}

/** Omp v18.9.1 approval-policy description: tools/settings.ts:294-305. */
const approvalPoliciesControl: MapSettingControl = {
  key: "tools.approval",
  label: "Tool Approval Policies",
  description:
    "Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
  kind: "map",
  secret: false,
  keyLabel: "Tool name",
  keyPlaceholder: "e.g. bash",
  value: { label: "Policy", kind: "enum", options: TOOL_APPROVAL_POLICY_OPTIONS },
  addLabel: "Add tool policy",
  emptyLabel: "No per-tool approval overrides",
  validate: validateApprovalPolicies,
  apply: "live",
};

function section(
  id: SettingsSectionDescriptor["id"],
  name: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
  requires: readonly CapabilityKey[] = HOST_CONFIG,
): SettingsSectionDescriptor {
  return { id, section: name, title, inventory, controls, requires };
}

/**
 * Keys, defaults, and enums follow omp v18.9.1. ConfigStore supplies each effective default and its
 * provenance rather than duplicating defaults here. Description ranges are recorded per key in
 * `test/interaction/sections.test.tsx`. Their witness commands (run inside the omp source checkout):
 * `git show v18.9.1:packages/coding-agent/src/modes/settings.ts`,
 * `git show v18.9.1:packages/coding-agent/src/tools/settings.ts`,
 * `git show v18.9.1:packages/coding-agent/src/modes/magic-keywords.ts`,
 * `git show v18.9.1:packages/coding-agent/src/collab/settings.ts`,
 * `git show v18.9.1:packages/coding-agent/src/commands/settings.ts`, and
 * `git show v18.9.1:packages/coding-agent/src/session/settings.ts`. The tree-filter and
 * word-completion enums are pi-tui/overlays/tree-selector.ts:12 and pi-tui/prompt/word-completion.ts:8.
 */
export const INPUT_SETTINGS_SECTION = section(
  "S1.interactionInput",
  "interaction/Input",
  "Input",
  ["S3.interaction-input"],
  [
    enumControl(
      "steeringMode",
      "Steering Mode",
      ["all", "one-at-a-time"],
      "live",
      { all: "All queued messages", "one-at-a-time": "One at a time" },
      "How to process queued messages while agent is working",
    ),
    enumControl(
      "followUpMode",
      "Follow-Up Mode",
      ["all", "one-at-a-time"],
      "live",
      { all: "All queued messages", "one-at-a-time": "One at a time" },
      "How to drain follow-up messages after a turn completes",
    ),
    enumControl(
      "interruptMode",
      "Interrupt Mode",
      ["immediate", "wait"],
      "live",
      { immediate: "Interrupt immediately", wait: "Wait for tool completion" },
      "When steering messages interrupt tool execution",
    ),
    booleanControl("tui.vimMode", "Vim Editing Mode", "live", terminalOnlyDescription()),
    enumControl(
      "tui.vimModeDisplay",
      "Vim Mode Indicator",
      ["text", "icon", "none"],
      "live",
      { text: "Text", icon: "Icon", none: "Hidden" },
      terminalOnlyDescription("Used in the status line only when Vim Editing Mode is enabled."),
    ),
    enumControl(
      "loop.mode",
      "Loop Mode",
      ["prompt", "compact", "reset"],
      "live",
      {
        prompt: "Prompt",
        compact: "Compact",
        reset: "Reset",
      },
      terminalOnlyDescription(),
    ),
    numberControl(
      "loop.conditionTimeoutMs",
      "Loop Condition Timeout (ms)",
      0,
      Number.MAX_VALUE,
      "live",
      false,
      terminalOnlyDescription(),
    ),
    booleanControl(
      "composer.predictions",
      "Composer Predictions",
      "live",
      terminalOnlyDescription(
        "After a completed turn, omp's terminal can show a predicted next message as ghost text; this uses one extra billed request per turn. Chats in this app do not use predictions.",
      ),
    ),
    booleanControl(
      "composer.recallClearedDrafts",
      "Recall Cleared Drafts",
      "live",
      terminalOnlyDescription(),
    ),
    enumControl(
      "doubleEscapeAction",
      "Double-Escape Action",
      ["rewind", "tree", "none"],
      "live",
      { rewind: "Rewind", tree: "Session tree", none: "Do nothing" },
      terminalOnlyDescription(),
    ),
    booleanControl(
      "input.bareExitOnEmptySession",
      "Bare Exit on Empty Session",
      "live",
      terminalOnlyDescription(),
    ),
    booleanControl(
      "input.bareSlashCommands",
      "Bare Slash Commands",
      "live",
      terminalOnlyDescription(),
    ),
    enumControl(
      "treeFilterMode",
      "Session Tree Filter",
      ["default", "no-tools", "user-only", "labeled-only", "all"],
      "live",
      { "no-tools": "No tools", "user-only": "User only", "labeled-only": "Labeled", all: "All" },
      terminalOnlyDescription(),
    ),
    numberControl(
      "autocompleteMaxVisible",
      "Autocomplete Items",
      3,
      20,
      "live",
      true,
      terminalOnlyDescription(),
    ),
    booleanControl(
      "spelling.typoDetection",
      "Typo Detection (macOS)",
      "live",
      terminalOnlyDescription("Uses the host's macOS dictionaries."),
    ),
    enumControl(
      "spelling.autocomplete",
      "Word Autocomplete",
      ["off", "auto", "ngram", "smollm", "apple"],
      "live",
      { off: "Off", auto: "Auto", ngram: "N-gram", smollm: "SmolLM", apple: "Apple (macOS only)" },
      "Show predicted word completions as inline hints: Tab accepts with a space, Right without",
    ),
    booleanControl(
      "spelling.autocorrect",
      "Autocorrect (macOS)",
      "live",
      terminalOnlyDescription("Uses the host's macOS dictionaries."),
    ),
    booleanControl("emojiAutocomplete", "Emoji Autocomplete", "live", terminalOnlyDescription()),
    numberControl(
      "paste.largeMenuThreshold",
      "Large Paste Menu",
      0,
      Number.MAX_VALUE,
      "live",
      true,
      terminalOnlyDescription(),
    ),
  ],
);

export const APPROVALS_SECTION = section(
  "S1.interactionApprovals",
  "interaction/Approvals",
  "Approvals",
  ["S3.interaction-approvals"],
  [
    approvalPoliciesControl,
    enumControl(
      "tools.approvalMode",
      "Approval Mode",
      ["always-ask", "write", "yolo"],
      "live",
      {
        "always-ask": "Always ask",
        write: "Write",
        yolo: "Yolo",
      },
      "Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
    ),
  ],
);

export const NOTIFICATIONS_SETTINGS_SECTION = section(
  "S1.interactionNotifications",
  "interaction/Notifications",
  "Notifications",
  ["S3.interaction-notifications"],
  [
    enumControl(
      "completion.notify",
      "Completion Notification",
      ["on", "off"],
      "live",
      { on: "On", off: "Off" },
      terminalOnlyDescription(),
    ),
    enumControl(
      "error.notify",
      "Error Notification",
      ["on", "off"],
      "live",
      { on: "On", off: "Off" },
      terminalOnlyDescription(),
    ),
    numberControl(
      "ask.timeout",
      "Ask Timeout (seconds)",
      0,
      Number.MAX_VALUE,
      "live",
      false,
      "Auto-select the recommended ask option after this many seconds (0 disables). Also bounds cfg:// approval prompts; an unanswered approval denies the write instead of auto-selecting",
    ),
    enumControl(
      "ask.notify",
      "Ask Notification",
      ["on", "off"],
      "live",
      { on: "On", off: "Off" },
      "Notify when the ask tool is waiting for input",
    ),
    booleanControl("recap.enabled", "Idle Recap", "live", terminalOnlyDescription()),
    numberControl(
      "recap.idleSeconds",
      "Idle Recap Delay (seconds)",
      0,
      Number.MAX_VALUE,
      "live",
      false,
      terminalOnlyDescription(),
    ),
  ],
);

export const COLLAB_SETTINGS_SECTION = section(
  "S1.interactionCollab",
  "interaction/Collab",
  "Collab",
  ["S3.interaction-collab"],
  [
    urlControl(
      "collab.relayUrl",
      "Relay URL",
      validateRelayUrl,
      "Relay used by /collab (wss://host[:port])",
    ),
    urlControl(
      "collab.webUrl",
      "Web UI URL",
      validateUrl,
      "Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
    ),
    textControl(
      "collab.displayName",
      "Display Name",
      "live",
      "Name shown to other collab participants (default: OS username)",
    ),
    enumControl(
      "collab.autoStart",
      "Auto Start",
      ["off", "view", "control"],
      "session",
      { off: "Off", view: "View only", control: "Control" },
      "Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch",
    ),
    urlControl(
      "share.serverUrl",
      "Share Server",
      validateUrl,
      "Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)",
    ),
    enumControl(
      "share.store",
      "Share Store",
      ["blob", "gist"],
      "live",
      { blob: "Encrypted blob", gist: "GitHub gist" },
      "Where /share uploads the encrypted session blob",
    ),
    booleanControl(
      "share.redactSecrets",
      "Share Secret Redaction",
      "live",
      "Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)",
    ),
  ],
);

export const MAGIC_KEYWORDS_SETTINGS_SECTION = section(
  "S1.interactionMagicKeywords",
  "interaction/Magic Keywords",
  "Magic Keywords",
  ["S3.interaction-magic-keywords"],
  [
    booleanControl(
      "magicKeywords.enabled",
      "Magic Keywords",
      "live",
      "Enable hidden notices for standalone ultrathink, orchestrate, workflowz, jevify keywords",
    ),
    booleanControl(
      "magicKeywords.ultrathink",
      "Ultrathink Keyword",
      "live",
      "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
    ),
    booleanControl(
      "magicKeywords.orchestrate",
      "Orchestrate Keyword",
      "live",
      "Let standalone orchestrate append its hidden multi-agent orchestration notice",
    ),
    booleanControl(
      "magicKeywords.workflow",
      "Workflow Keyword",
      "live",
      "Let standalone workflowz append its hidden eval workflow notice",
    ),
    booleanControl(
      "magicKeywords.jevify",
      "Jevify Keyword",
      "live",
      "Let standalone jevify append its hidden bulk-judge classification notice",
    ),
  ],
);

export const STARTUP_UPDATES_SETTINGS_SECTION = section(
  "S1.interactionStartupUpdates",
  "interaction/Startup & Updates",
  "Startup & Updates",
  ["S3.interaction-startup-updates"],
  [
    booleanControl(
      "autoResume",
      "Auto Resume",
      "restart",
      "Automatically resume the most recent session in the current directory",
    ),
    booleanControl(
      "startup.quiet",
      "Quiet Startup",
      "restart",
      terminalOnlyDescription("Skip welcome screen and startup status messages"),
    ),
    booleanControl(
      "startup.showSplash",
      "Show Startup Splash",
      "restart",
      terminalOnlyDescription(
        "Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
      ),
    ),
    booleanControl(
      "startup.setupWizard",
      "Setup Wizard",
      "restart",
      terminalOnlyDescription("Show newly added onboarding steps once per setup version"),
    ),
    booleanControl(
      "startup.checkUpdate",
      "Check for Updates",
      "restart",
      terminalOnlyDescription("Check for omp updates on startup"),
    ),
    enumControl(
      "update.channel",
      "Update Channel",
      ["stable", "canary"],
      "restart",
      { stable: "Stable", canary: "Canary" },
      "Update channel used by omp update and the startup update check",
    ),
    enumControl(
      "marketplace.autoUpdate",
      "Marketplace Auto-Update",
      ["off", "notify", "auto"],
      "restart",
      { off: "Off", notify: "Notify", auto: "Automatic" },
      "Check for plugin updates on startup",
    ),
    enumControl(
      "startup.changelogMode",
      "Startup Changelog",
      ["summary", "expanded", "hidden"],
      "restart",
      { summary: "Summary", expanded: "Expanded", hidden: "Hidden" },
      "Choose whether update notes start as a summary, full details, or stay hidden",
    ),
  ],
);

export const POWER_SETTINGS_SECTION = section(
  "S1.interactionPower",
  "interaction/Power",
  "Power",
  ["S3.interaction-power"],
  [
    enumControl(
      "power.sleepPrevention",
      "Sleep Prevention",
      ["off", "idle", "display", "system"],
      "live",
      {
        off: "Off",
        idle: "Prevent idle sleep",
        display: "Prevent display sleep",
        system: "Prevent system sleep",
      },
      "Prevent the system sleeping during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
    ),
  ],
  HOST_CONFIG,
);

export const AGENT_SETTINGS_SECTION = section(
  "S1.interactionAgent",
  "interaction/Agent",
  "Agent",
  ["S3.interaction-agent"],
  [
    enumControl(
      "features.unexpectedStopDetection",
      "Unexpected Stops",
      ["none", "mechanical", "smart"],
      "live",
      { none: "None", mechanical: "Mechanical", smart: "Smart" },
      "Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model.",
    ),
  ],
);

export const GIT_SETTINGS_SECTION = section(
  "S1.interactionGit",
  "interaction/Git",
  "Git",
  ["S3.interaction-git"],
  [booleanControl("git.enabled", "Enable Git Integration", "live", terminalOnlyDescription())],
  HOST_CONFIG,
);

/** The nine owned interaction settings sections. */
export const S1_INTERACTION_SECTIONS: readonly SettingsSectionDescriptor[] = [
  INPUT_SETTINGS_SECTION,
  APPROVALS_SECTION,
  NOTIFICATIONS_SETTINGS_SECTION,
  COLLAB_SETTINGS_SECTION,
  MAGIC_KEYWORDS_SETTINGS_SECTION,
  STARTUP_UPDATES_SETTINGS_SECTION,
  POWER_SETTINGS_SECTION,
  AGENT_SETTINGS_SECTION,
  GIT_SETTINGS_SECTION,
];
