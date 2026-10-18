import type { ConfigValue, JsonValue, SecretStatus } from "@omp-app/contracts";
import type { ConfigSnapshot, SettingsSectionDescriptor } from "../settings-kit";
import {
  AGENT_SETTINGS_SECTION,
  APPROVALS_SECTION,
  COLLAB_SETTINGS_SECTION,
  GIT_SETTINGS_SECTION,
  INPUT_SETTINGS_SECTION,
  MAGIC_KEYWORDS_SETTINGS_SECTION,
  NOTIFICATIONS_SETTINGS_SECTION,
  POWER_SETTINGS_SECTION,
  STARTUP_UPDATES_SETTINGS_SECTION,
  TOOL_APPROVAL_POLICY_VALUES,
} from "./descriptors";

export type InteractionSetting<T> =
  | (Omit<ConfigValue, "value"> & { readonly value: T })
  | SecretStatus;

export type InteractionSectionSnapshot<T> = {
  readonly folder: ConfigSnapshot["folder"];
  readonly revision: ConfigSnapshot["revision"];
  readonly settings: { readonly [K in keyof T]: InteractionSetting<T[K]> };
};

export type InputSettings = {
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
  readonly interruptMode: "immediate" | "wait";
  readonly vimMode: boolean;
  readonly vimModeDisplay: "text" | "icon" | "none";
  readonly loopMode: "prompt" | "compact" | "reset";
  readonly loopConditionTimeoutMs: number;
  readonly recallClearedDrafts: boolean;
  readonly doubleEscapeAction: "rewind" | "tree" | "none";
  readonly bareExitOnEmptySession: boolean;
  readonly bareSlashCommands: boolean;
  readonly treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  readonly autocompleteMaxVisible: number;
  readonly typoDetection: boolean;
  readonly spellingAutocomplete: "off" | "auto" | "ngram" | "smollm" | "apple";
  readonly autocorrect: boolean;
  readonly emojiAutocomplete: boolean;
  readonly largePasteMenuThreshold: number;
};

export type ToolApprovalMode = "always-ask" | "write" | "yolo";
export type ToolApprovalPolicy = (typeof TOOL_APPROVAL_POLICY_VALUES)[number] | "unknown";
export type ToolApprovalPolicies = Readonly<Record<string, ToolApprovalPolicy>>;
export type ApprovalSettingsSnapshot = {
  readonly mode: InteractionSectionSnapshot<{ readonly mode: ToolApprovalMode }>;
  readonly policies: InteractionSectionSnapshot<{ readonly policies: ToolApprovalPolicies }>;
};

export type NotificationSettings = {
  readonly completionNotify: "on" | "off";
  readonly errorNotify: "on" | "off";
  readonly askTimeout: number;
  readonly askNotify: "on" | "off";
  readonly recapEnabled: boolean;
  readonly recapIdleSeconds: number;
};

export type CollaborationSettings = {
  readonly relayUrl: string;
  readonly webUrl: string;
  readonly displayName: string;
  readonly autoStart: "off" | "view" | "control";
  readonly shareServerUrl: string;
  readonly shareStore: "blob" | "gist";
  readonly redactShareSecrets: boolean;
};

export type MagicKeywordSettings = {
  readonly enabled: boolean;
  readonly ultrathink: boolean;
  readonly orchestrate: boolean;
  readonly workflow: boolean;
  readonly jevify: boolean;
};

export type StartupUpdateSettings = {
  readonly autoResume: boolean;
  readonly quiet: boolean;
  readonly showSplash: boolean;
  readonly setupWizard: boolean;
  readonly checkUpdate: boolean;
  readonly marketplaceAutoUpdate: "off" | "notify" | "auto";
  readonly changelogMode: "summary" | "expanded" | "hidden";
  readonly updateChannel: "stable" | "canary";
};

export type PowerSettings = { readonly sleepPrevention: "off" | "idle" | "display" | "system" };
export type AgentSettings = { readonly unexpectedStopDetection: "none" | "mechanical" | "smart" };
export type GitSettings = { readonly enabled: boolean };

export type InteractionConfigSnapshots = {
  readonly input: ConfigSnapshot;
  readonly approvals: ConfigSnapshot;
  readonly notifications: ConfigSnapshot;
  readonly collab: ConfigSnapshot;
  readonly magicKeywords: ConfigSnapshot;
  readonly startupUpdates: ConfigSnapshot;
  readonly power: ConfigSnapshot;
  readonly agent: ConfigSnapshot;
  readonly git: ConfigSnapshot;
};

export type InteractionSettingsSnapshot = {
  readonly input: InteractionSectionSnapshot<InputSettings>;
  readonly approvals: ApprovalSettingsSnapshot;
  readonly notifications: InteractionSectionSnapshot<NotificationSettings>;
  readonly collaboration: InteractionSectionSnapshot<CollaborationSettings>;
  readonly magicKeywords: InteractionSectionSnapshot<MagicKeywordSettings>;
  readonly startupUpdates: InteractionSectionSnapshot<StartupUpdateSettings>;
  readonly power: InteractionSectionSnapshot<PowerSettings>;
  readonly agent: InteractionSectionSnapshot<AgentSettings>;
  readonly git: InteractionSectionSnapshot<GitSettings>;
};

function enumValue<const Values extends readonly string[]>(values: Values) {
  return (value: JsonValue): Values[number] | undefined => {
    if (typeof value !== "string") return undefined;
    return values.find((candidate) => candidate === value);
  };
}

function booleanValue(value: JsonValue): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: JsonValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: JsonValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function projectSetting<T>(
  snapshot: ConfigSnapshot,
  descriptor: SettingsSectionDescriptor,
  key: string,
  parse: (value: JsonValue) => T | undefined,
): InteractionSetting<T> {
  if (!descriptor.controls.some((control) => control.key === key)) {
    throw new Error(`Interaction descriptor is missing ${key}.`);
  }
  const entry = snapshot.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Interaction snapshot is missing ${key}.`);
  if (entry.secret) return entry;

  // Effective values may be outside write-time bounds or use broader URLs than the UI accepts.
  // Projection is a type/domain boundary; validators remain the write path's guard.
  const value = parse(entry.value);
  if (value === undefined) {
    throw new Error(`Invalid effective value for interaction setting ${key} (type).`);
  }
  return { ...entry, value };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePolicies(value: JsonValue): ToolApprovalPolicies {
  if (!isJsonRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([tool, policy]) => [
      tool,
      TOOL_APPROVAL_POLICY_VALUES.find((allowed) => allowed === policy) ?? "unknown",
    ]),
  );
}

function projectApprovalPolicies(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<{ readonly policies: ToolApprovalPolicies }> {
  const key = "tools.approval";
  const entry = snapshot.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Interaction snapshot is missing ${key}.`);
  if (entry.secret) {
    return {
      folder: snapshot.folder,
      revision: snapshot.revision,
      settings: { policies: entry },
    };
  }
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: { policies: { ...entry, value: safePolicies(entry.value) } },
  };
}

export function projectInputSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<InputSettings> {
  const values = {
    steeringMode: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "steeringMode",
      enumValue(["all", "one-at-a-time"]),
    ),
    followUpMode: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "followUpMode",
      enumValue(["all", "one-at-a-time"]),
    ),
    interruptMode: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "interruptMode",
      enumValue(["immediate", "wait"]),
    ),
    vimMode: projectSetting(snapshot, INPUT_SETTINGS_SECTION, "tui.vimMode", booleanValue),
    vimModeDisplay: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "tui.vimModeDisplay",
      enumValue(["text", "icon", "none"]),
    ),
    loopMode: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "loop.mode",
      enumValue(["prompt", "compact", "reset"]),
    ),
    loopConditionTimeoutMs: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "loop.conditionTimeoutMs",
      numberValue,
    ),
    composerPredictions: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "composer.predictions",
      booleanValue,
    ),
    recallClearedDrafts: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "composer.recallClearedDrafts",
      booleanValue,
    ),
    doubleEscapeAction: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "doubleEscapeAction",
      enumValue(["rewind", "tree", "none"]),
    ),
    bareExitOnEmptySession: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "input.bareExitOnEmptySession",
      booleanValue,
    ),
    bareSlashCommands: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "input.bareSlashCommands",
      booleanValue,
    ),
    treeFilterMode: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "treeFilterMode",
      enumValue(["default", "no-tools", "user-only", "labeled-only", "all"]),
    ),
    autocompleteMaxVisible: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "autocompleteMaxVisible",
      numberValue,
    ),
    typoDetection: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "spelling.typoDetection",
      booleanValue,
    ),
    spellingAutocomplete: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "spelling.autocomplete",
      enumValue(["off", "auto", "ngram", "smollm", "apple"]),
    ),
    autocorrect: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "spelling.autocorrect",
      booleanValue,
    ),
    emojiAutocomplete: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "emojiAutocomplete",
      booleanValue,
    ),
    largePasteMenuThreshold: projectSetting(
      snapshot,
      INPUT_SETTINGS_SECTION,
      "paste.largeMenuThreshold",
      numberValue,
    ),
  };
  return { folder: snapshot.folder, revision: snapshot.revision, settings: values };
}

export function projectApprovalMode(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<{ readonly mode: ToolApprovalMode }> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      mode: projectSetting(
        snapshot,
        APPROVALS_SECTION,
        "tools.approvalMode",
        enumValue(["always-ask", "write", "yolo"]),
      ),
    },
  };
}

export function projectApprovalSettings(snapshot: ConfigSnapshot): ApprovalSettingsSnapshot {
  return {
    mode: projectApprovalMode(snapshot),
    policies: projectApprovalPolicies(snapshot),
  };
}

export function projectNotificationSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<NotificationSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      completionNotify: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "completion.notify",
        enumValue(["on", "off"]),
      ),
      errorNotify: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "error.notify",
        enumValue(["on", "off"]),
      ),
      askTimeout: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "ask.timeout",
        numberValue,
      ),
      askNotify: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "ask.notify",
        enumValue(["on", "off"]),
      ),
      recapEnabled: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "recap.enabled",
        booleanValue,
      ),
      recapIdleSeconds: projectSetting(
        snapshot,
        NOTIFICATIONS_SETTINGS_SECTION,
        "recap.idleSeconds",
        numberValue,
      ),
    },
  };
}

export function projectCollaborationSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<CollaborationSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      relayUrl: projectSetting(snapshot, COLLAB_SETTINGS_SECTION, "collab.relayUrl", stringValue),
      webUrl: projectSetting(snapshot, COLLAB_SETTINGS_SECTION, "collab.webUrl", stringValue),
      displayName: projectSetting(
        snapshot,
        COLLAB_SETTINGS_SECTION,
        "collab.displayName",
        stringValue,
      ),
      autoStart: projectSetting(
        snapshot,
        COLLAB_SETTINGS_SECTION,
        "collab.autoStart",
        enumValue(["off", "view", "control"]),
      ),
      shareServerUrl: projectSetting(
        snapshot,
        COLLAB_SETTINGS_SECTION,
        "share.serverUrl",
        stringValue,
      ),
      shareStore: projectSetting(
        snapshot,
        COLLAB_SETTINGS_SECTION,
        "share.store",
        enumValue(["blob", "gist"]),
      ),
      redactShareSecrets: projectSetting(
        snapshot,
        COLLAB_SETTINGS_SECTION,
        "share.redactSecrets",
        booleanValue,
      ),
    },
  };
}

export function projectMagicKeywordSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<MagicKeywordSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      enabled: projectSetting(
        snapshot,
        MAGIC_KEYWORDS_SETTINGS_SECTION,
        "magicKeywords.enabled",
        booleanValue,
      ),
      ultrathink: projectSetting(
        snapshot,
        MAGIC_KEYWORDS_SETTINGS_SECTION,
        "magicKeywords.ultrathink",
        booleanValue,
      ),
      orchestrate: projectSetting(
        snapshot,
        MAGIC_KEYWORDS_SETTINGS_SECTION,
        "magicKeywords.orchestrate",
        booleanValue,
      ),
      workflow: projectSetting(
        snapshot,
        MAGIC_KEYWORDS_SETTINGS_SECTION,
        "magicKeywords.workflow",
        booleanValue,
      ),
      jevify: projectSetting(
        snapshot,
        MAGIC_KEYWORDS_SETTINGS_SECTION,
        "magicKeywords.jevify",
        booleanValue,
      ),
    },
  };
}

export function projectStartupUpdateSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<StartupUpdateSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      autoResume: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "autoResume",
        booleanValue,
      ),
      quiet: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "startup.quiet",
        booleanValue,
      ),
      showSplash: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "startup.showSplash",
        booleanValue,
      ),
      setupWizard: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "startup.setupWizard",
        booleanValue,
      ),
      checkUpdate: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "startup.checkUpdate",
        booleanValue,
      ),
      marketplaceAutoUpdate: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "marketplace.autoUpdate",
        enumValue(["off", "notify", "auto"]),
      ),
      changelogMode: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "startup.changelogMode",
        enumValue(["summary", "expanded", "hidden"]),
      ),
      updateChannel: projectSetting(
        snapshot,
        STARTUP_UPDATES_SETTINGS_SECTION,
        "update.channel",
        enumValue(["stable", "canary"]),
      ),
    },
  };
}

export function projectPowerSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<PowerSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      sleepPrevention: projectSetting(
        snapshot,
        POWER_SETTINGS_SECTION,
        "power.sleepPrevention",
        enumValue(["off", "idle", "display", "system"]),
      ),
    },
  };
}

export function projectAgentSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<AgentSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      unexpectedStopDetection: projectSetting(
        snapshot,
        AGENT_SETTINGS_SECTION,
        "features.unexpectedStopDetection",
        enumValue(["none", "mechanical", "smart"]),
      ),
    },
  };
}

export function projectGitSettings(
  snapshot: ConfigSnapshot,
): InteractionSectionSnapshot<GitSettings> {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    settings: {
      enabled: projectSetting(snapshot, GIT_SETTINGS_SECTION, "git.enabled", booleanValue),
    },
  };
}

export function projectInteractionSettingsSnapshot(
  snapshots: InteractionConfigSnapshots,
): InteractionSettingsSnapshot {
  return {
    input: projectInputSettings(snapshots.input),
    approvals: projectApprovalSettings(snapshots.approvals),
    notifications: projectNotificationSettings(snapshots.notifications),
    collaboration: projectCollaborationSettings(snapshots.collab),
    magicKeywords: projectMagicKeywordSettings(snapshots.magicKeywords),
    startupUpdates: projectStartupUpdateSettings(snapshots.startupUpdates),
    power: projectPowerSettings(snapshots.power),
    agent: projectAgentSettings(snapshots.agent),
    git: projectGitSettings(snapshots.git),
  };
}
