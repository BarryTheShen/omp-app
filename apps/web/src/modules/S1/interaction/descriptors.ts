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
import { settingOptions } from "../settings-kit";

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];
const HOST_CONFIG_AND_GIT = ["host.config", "host.git"] as const satisfies readonly CapabilityKey[];
const HOST_CONFIG_AND_POWER = [
  "host.config",
  "host.power",
] as const satisfies readonly CapabilityKey[];

/** Exact `tools.approval` values from omp v18.6.1's settings registration. */
export const TOOL_APPROVAL_POLICY_VALUES = ["allow", "prompt", "deny"] as const;

const TOOL_APPROVAL_POLICY_LABELS = {
  allow: "Allow",
  prompt: "Prompt",
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
      : invalid("range", `Enter a ${integer ? "whole " : ""}number from ${minimum} to ${maximum}.`);
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

/** Registration and the allow/prompt/deny policy values: omp v18.6.1 tools/settings.ts:294-307. */
const approvalPoliciesControl: MapSettingControl = {
  key: "tools.approval",
  label: "Tool Approval Policies",
  description:
    "Per-tool approval policies override the default approval mode. Allow auto-approves, Prompt requests confirmation, and Deny blocks a tool.",
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
 * Keys, defaults, and enums follow omp v18.6.1. ConfigStore supplies each effective default and its
 * provenance rather than duplicating defaults here. Source registrations: modes/settings.ts:694-989
 * (Input), 29-50 (Auto Resume/Git), 991-1088 (Startup & Updates), and 1105-1216 (Magic Keywords /
 * Notifications); modes/magic-keywords.ts:47-100; tools/settings.ts:294-333 (Approvals);
 * collab/settings.ts:9-69 and commands/settings.ts:8-55 (Collab); session/settings.ts:37-56 (Power)
 * and 1011-1035 (Agent). The tree-filter and word-completion enums are
 * pi-tui/overlays/tree-selector.ts:12 and pi-tui/prompt/word-completion.ts:8.
 */
export const INPUT_SETTINGS_SECTION = section(
  "S1.interactionInput",
  "interaction/Input",
  "Input",
  ["S3.interaction-input"],
  [
    enumControl("steeringMode", "Steering Mode", ["all", "one-at-a-time"], "session", {
      all: "All queued messages",
      "one-at-a-time": "One at a time",
    }),
    enumControl("followUpMode", "Follow-Up Mode", ["all", "one-at-a-time"], "session", {
      all: "All queued messages",
      "one-at-a-time": "One at a time",
    }),
    enumControl("interruptMode", "Interrupt Mode", ["immediate", "wait"], "session", {
      immediate: "Interrupt immediately",
      wait: "Wait for tool completion",
    }),
    booleanControl("tui.vimMode", "Vim Editing Mode"),
    enumControl(
      "tui.vimModeDisplay",
      "Vim Mode Indicator",
      ["text", "icon", "none"],
      "live",
      { text: "Text", icon: "Icon", none: "Hidden" },
      "Used in the status line only when Vim Editing Mode is enabled.",
    ),
    enumControl("loop.mode", "Loop Mode", ["prompt", "compact", "reset"], "live", {
      prompt: "Prompt",
      compact: "Compact",
      reset: "Reset",
    }),
    numberControl("loop.conditionTimeoutMs", "Loop Condition Timeout (ms)", 0, Number.MAX_VALUE),
    booleanControl("composer.recallClearedDrafts", "Recall Cleared Drafts"),
    enumControl("doubleEscapeAction", "Double-Escape Action", ["rewind", "tree", "none"], "live", {
      rewind: "Rewind",
      tree: "Session tree",
      none: "Do nothing",
    }),
    booleanControl("input.bareExitOnEmptySession", "Bare Exit on Empty Session"),
    booleanControl("input.bareSlashCommands", "Bare Slash Commands"),
    enumControl(
      "treeFilterMode",
      "Session Tree Filter",
      ["default", "no-tools", "user-only", "labeled-only", "all"],
      "live",
      { "no-tools": "No tools", "user-only": "User only", "labeled-only": "Labeled", all: "All" },
    ),
    numberControl("autocompleteMaxVisible", "Autocomplete Items", 3, 20, "live", true),
    booleanControl(
      "spelling.typoDetection",
      "Typo Detection (macOS)",
      "live",
      "Uses the host's macOS dictionaries.",
    ),
    enumControl(
      "spelling.autocomplete",
      "Word Autocomplete",
      ["off", "auto", "ngram", "smollm", "apple"],
      "live",
      { off: "Off", auto: "Auto", ngram: "N-gram", smollm: "SmolLM", apple: "Apple (macOS only)" },
    ),
    booleanControl(
      "spelling.autocorrect",
      "Autocorrect (macOS)",
      "live",
      "Uses the host's macOS dictionaries.",
    ),
    booleanControl("emojiAutocomplete", "Emoji Autocomplete"),
    numberControl(
      "paste.largeMenuThreshold",
      "Large Paste Menu",
      0,
      Number.MAX_VALUE,
      "live",
      true,
    ),
  ],
);

export const APPROVALS_SECTION = section(
  "S1.interactionApprovals",
  "interaction/Approvals",
  "Tool Approval",
  ["S3.interaction-approvals"],
  [
    approvalPoliciesControl,
    enumControl("tools.approvalMode", "Tool Approval", ["always-ask", "write", "yolo"], "live", {
      "always-ask": "Always ask",
      write: "Write",
      yolo: "Yolo",
    }),
  ],
);

export const NOTIFICATIONS_SETTINGS_SECTION = section(
  "S1.interactionNotifications",
  "interaction/Notifications",
  "Notifications",
  ["S3.interaction-notifications"],
  [
    enumControl("completion.notify", "Completion Notification", ["on", "off"], "live", {
      on: "On",
      off: "Off",
    }),
    enumControl("error.notify", "Error Notification", ["on", "off"], "live", {
      on: "On",
      off: "Off",
    }),
    numberControl("ask.timeout", "Ask Timeout (seconds)", 0, Number.MAX_VALUE),
    enumControl("ask.notify", "Ask Notification", ["on", "off"], "live", { on: "On", off: "Off" }),
    booleanControl("recap.enabled", "Idle Recap"),
    numberControl("recap.idleSeconds", "Idle Recap Delay (seconds)", 0, Number.MAX_VALUE),
  ],
);

export const COLLAB_SETTINGS_SECTION = section(
  "S1.interactionCollab",
  "interaction/Collab",
  "Collab",
  ["S3.interaction-collab"],
  [
    urlControl("collab.relayUrl", "Relay URL", validateRelayUrl),
    urlControl(
      "collab.webUrl",
      "Web UI URL",
      validateUrl,
      "Leave blank to derive the web URL from the relay URL.",
    ),
    textControl("collab.displayName", "Display Name"),
    enumControl("collab.autoStart", "Auto Start", ["off", "view", "control"], "session", {
      off: "Off",
      view: "View only",
      control: "Control",
    }),
    urlControl("share.serverUrl", "Share Server", validateUrl),
    enumControl("share.store", "Share Store", ["blob", "gist"], "live", {
      blob: "Encrypted blob",
      gist: "GitHub gist",
    }),
    booleanControl("share.redactSecrets", "Share Secret Redaction"),
  ],
);

export const MAGIC_KEYWORDS_SETTINGS_SECTION = section(
  "S1.interactionMagicKeywords",
  "interaction/Magic Keywords",
  "Magic Keywords",
  ["S3.interaction-magic-keywords"],
  [
    booleanControl("magicKeywords.enabled", "Magic Keywords"),
    booleanControl("magicKeywords.ultrathink", "Ultrathink Keyword"),
    booleanControl("magicKeywords.orchestrate", "Orchestrate Keyword"),
    booleanControl("magicKeywords.workflow", "Workflow Keyword"),
    booleanControl("magicKeywords.jevify", "Jevify Keyword"),
  ],
);

export const STARTUP_UPDATES_SETTINGS_SECTION = section(
  "S1.interactionStartupUpdates",
  "interaction/Startup & Updates",
  "Startup & Updates",
  ["S3.interaction-startup-updates"],
  [
    booleanControl("autoResume", "Auto Resume", "restart"),
    booleanControl("startup.quiet", "Quiet Startup", "restart"),
    booleanControl("startup.showSplash", "Show Startup Splash", "restart"),
    booleanControl("startup.setupWizard", "Setup Wizard", "restart"),
    booleanControl("startup.checkUpdate", "Check for Updates", "restart"),
    enumControl("update.channel", "Update Channel", ["stable", "canary"], "restart", {
      stable: "Stable",
      canary: "Canary",
    }),
    enumControl(
      "marketplace.autoUpdate",
      "Marketplace Auto-Update",
      ["off", "notify", "auto"],
      "restart",
      {
        off: "Off",
        notify: "Notify",
        auto: "Automatic",
      },
    ),
    enumControl(
      "startup.changelogMode",
      "Startup Changelog",
      ["summary", "expanded", "hidden"],
      "restart",
      {
        summary: "Summary",
        expanded: "Expanded",
        hidden: "Hidden",
      },
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
    ),
  ],
  HOST_CONFIG_AND_POWER,
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
      "session",
      { none: "None", mechanical: "Mechanical", smart: "Smart" },
    ),
  ],
);

export const GIT_SETTINGS_SECTION = section(
  "S1.interactionGit",
  "interaction/Git",
  "Git",
  ["S3.interaction-git"],
  [booleanControl("git.enabled", "Enable Git Integration", "live")],
  HOST_CONFIG_AND_GIT,
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
