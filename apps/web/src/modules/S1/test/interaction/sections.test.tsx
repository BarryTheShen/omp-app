import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ConfigSnapshot,
  SettingControl,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import { SettingsSection } from "../../../S1/settings-kit";
import {
  AGENT_SETTINGS_SECTION,
  APPROVALS_SECTION,
  COLLAB_SETTINGS_SECTION,
  GIT_SETTINGS_SECTION,
  INPUT_SETTINGS_SECTION,
  type InteractionSetting,
  MAGIC_KEYWORDS_SETTINGS_SECTION,
  NOTIFICATIONS_SETTINGS_SECTION,
  POWER_SETTINGS_SECTION,
  projectInteractionSettingsSnapshot,
  S1_INTERACTION_SECTIONS,
  STARTUP_UPDATES_SETTINGS_SECTION,
  TOOL_APPROVAL_POLICY_VALUES,
} from "../../interaction";

// Each row is the exact ui.description at its source line in omp v18.9.1. Witness commands:
// `git -C /home/user/workspace/projects/omp-app/.data/scratch/omp-src.git show v18.9.1:<source>`.
// The D1 settings-registry fixture has no ui.description field, so these upstream source literals
// pin each key. Terminal-only descriptions keep their source text here and the shared prefix in UI.
const OMP_DESCRIPTION_ROWS: readonly {
  readonly key: string;
  readonly description: string;
  readonly source: string;
}[] = [
  {
    key: "steeringMode",
    description: "How to process queued messages while agent is working",
    source: "modes/settings.ts:758",
  },
  {
    key: "followUpMode",
    description: "How to drain follow-up messages after a turn completes",
    source: "modes/settings.ts:771",
  },
  {
    key: "interruptMode",
    description: "When steering messages interrupt tool execution",
    source: "modes/settings.ts:784",
  },
  {
    key: "tui.vimMode",
    description:
      "Modal prompt editing. Escape leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes",
    source: "modes/settings.ts:797",
  },
  {
    key: "tui.vimModeDisplay",
    description: "How the current Vim mode appears in the status line",
    source: "modes/settings.ts:811",
  },
  {
    key: "loop.mode",
    description: "What happens between /loop iterations before re-submitting the prompt",
    source: "modes/settings.ts:830",
  },
  {
    key: "loop.conditionTimeoutMs",
    description:
      "Max wait for a `/loop --while` / `--until` condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely",
    source: "modes/settings.ts:855",
  },
  {
    key: "composer.predictions",
    description:
      "After a completed turn, ask the active model to predict your next message and show it as ghost text in the empty composer; Tab or Right inserts it without sending. Extra usage: every completed turn sends one more billed request over the whole conversation (counted in /stats)",
    source: "modes/settings.ts:1009",
  },
  {
    key: "composer.recallClearedDrafts",
    description:
      "Keep drafts cleared with Ctrl+C in local Up/Down history until exit; disabling affects future clears",
    source: "modes/settings.ts:876",
  },
  {
    key: "doubleEscapeAction",
    description:
      "What pressing Escape twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing",
    source: "modes/settings.ts:891",
  },
  {
    key: "input.bareExitOnEmptySession",
    description:
      "Submitting exactly `exit`, `quit`, or `q` (any case) before the first message quits instead of prompting the model",
    source: "modes/settings.ts:904",
  },
  {
    key: "input.bareSlashCommands",
    description:
      "Submitting exactly a command name without the leading `/` (e.g. `model`, `compact`) runs that slash command; once the session has messages, press Enter twice to confirm",
    source: "modes/settings.ts:917",
  },
  {
    key: "treeFilterMode",
    description: "Default filter mode when opening the session tree",
    source: "modes/settings.ts:931",
  },
  {
    key: "autocompleteMaxVisible",
    description: "Max visible items in autocomplete dropdown (3-20)",
    source: "modes/settings.ts:943",
  },
  {
    key: "spelling.typoDetection",
    description: "Mark misspelled prompt words with the active macOS dictionaries",
    source: "modes/settings.ts:963",
  },
  {
    key: "spelling.autocomplete",
    description:
      "Show predicted word completions as inline hints: Tab accepts with a space, Right without",
    source: "modes/settings.ts:978",
  },
  {
    key: "spelling.autocorrect",
    description: "Apply confident macOS spelling corrections after completed words",
    source: "modes/settings.ts:1022",
  },
  {
    key: "emojiAutocomplete",
    description:
      "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
    source: "modes/settings.ts:1035",
  },
  {
    key: "paste.largeMenuThreshold",
    description:
      "When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
    source: "modes/settings.ts:1048",
  },
  {
    key: "tools.approval",
    description:
      "Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
    source: "tools/settings.ts:302",
  },
  {
    key: "tools.approvalMode",
    description:
      "Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
    source: "tools/settings.ts:321",
  },
  {
    key: "completion.notify",
    description: "Notify when the agent finishes a turn",
    source: "modes/settings.ts:1209",
  },
  {
    key: "error.notify",
    description: "Notify when the agent stops with an error",
    source: "modes/settings.ts:1222",
  },
  {
    key: "ask.timeout",
    description:
      "Auto-select the recommended ask option after this many seconds (0 disables). Also bounds cfg:// approval prompts; an unanswered approval denies the write instead of auto-selecting",
    source: "modes/settings.ts:1235",
  },
  {
    key: "ask.notify",
    description: "Notify when the ask tool is waiting for input",
    source: "modes/settings.ts:1265",
  },
  {
    key: "recap.enabled",
    description:
      "Generate a brief LLM recap of where things stand after the terminal has been idle",
    source: "modes/settings.ts:1277",
  },
  {
    key: "recap.idleSeconds",
    description: "Seconds to wait while idle before showing the recap",
    source: "modes/settings.ts:1289",
  },
  {
    key: "collab.relayUrl",
    description: "Relay used by /collab (wss://host[:port])",
    source: "collab/settings.ts:17",
  },
  {
    key: "collab.webUrl",
    description:
      "Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
    source: "collab/settings.ts:29",
  },
  {
    key: "collab.displayName",
    description: "Name shown to other collab participants (default: OS username)",
    source: "collab/settings.ts:42",
  },
  {
    key: "collab.autoStart",
    description:
      "Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch",
    source: "collab/settings.ts:55",
  },
  {
    key: "share.serverUrl",
    description:
      "Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)",
    source: "commands/settings.ts:16",
  },
  {
    key: "share.store",
    description: "Where /share uploads the encrypted session blob",
    source: "commands/settings.ts:30",
  },
  {
    key: "share.redactSecrets",
    description:
      "Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)",
    source: "commands/settings.ts:54",
  },
  {
    key: "magicKeywords.enabled",
    description:
      "Enable hidden notices for standalone ultrathink, orchestrate, workflowz, jevify keywords",
    source: "modes/settings.ts:1182",
  },
  {
    key: "magicKeywords.ultrathink",
    description:
      "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
    source: "modes/magic-keywords.ts:74",
  },
  {
    key: "magicKeywords.orchestrate",
    description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
    source: "modes/magic-keywords.ts:83",
  },
  {
    key: "magicKeywords.workflow",
    description: "Let standalone workflowz append its hidden eval workflow notice",
    source: "modes/magic-keywords.ts:93",
  },
  {
    key: "magicKeywords.jevify",
    description: "Let standalone jevify append its hidden bulk-judge classification notice",
    source: "modes/magic-keywords.ts:102",
  },
  {
    key: "autoResume",
    description: "Automatically resume the most recent session in the current directory",
    source:
      "modes/settings.ts:38; main.ts:1284-1295,2054-2062; packages/server/src/process/omp-process.ts:15,262 (New chat uses rpc-ui without a session override, so this can resume the last folder session)",
  },
  {
    key: "startup.quiet",
    description: "Skip welcome screen and startup status messages",
    source: "modes/settings.ts:1068",
  },
  {
    key: "startup.showSplash",
    description:
      "Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
    source: "modes/settings.ts:1080",
  },
  {
    key: "startup.setupWizard",
    description: "Show newly added onboarding steps once per setup version",
    source: "modes/settings.ts:1093",
  },
  {
    key: "startup.checkUpdate",
    description: "Check for omp updates on startup",
    source: "modes/settings.ts:1105",
  },
  {
    key: "update.channel",
    description: "Update channel used by omp update and the startup update check",
    source: "modes/settings.ts:1118",
  },
  {
    key: "marketplace.autoUpdate",
    description: "Check for plugin updates on startup",
    source: "modes/settings.ts:1135",
  },
  {
    key: "startup.changelogMode",
    description: "Choose whether update notes start as a summary, full details, or stay hidden",
    source: "modes/settings.ts:1153",
  },
  {
    key: "power.sleepPrevention",
    description:
      "Prevent the system sleeping during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
    source: "session/settings.ts:47",
  },
  {
    key: "features.unexpectedStopDetection",
    description:
      "Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model.",
    source: "session/settings.ts:1061",
  },
  {
    key: "git.enabled",
    description:
      "Show git branch, status, and PR information in the TUI and watch repository metadata.",
    source: "modes/settings.ts:50",
  },
];
const TERMINAL_ONLY_DESCRIPTION_KEYS: Readonly<Record<string, true>> = {
  "tui.vimMode": true,
  "tui.vimModeDisplay": true,
  "loop.mode": true,
  "loop.conditionTimeoutMs": true,
  "composer.predictions": true,
  "composer.recallClearedDrafts": true,
  doubleEscapeAction: true,
  "input.bareExitOnEmptySession": true,
  "input.bareSlashCommands": true,
  treeFilterMode: true,
  autocompleteMaxVisible: true,
  "spelling.typoDetection": true,
  "spelling.autocorrect": true,
  emojiAutocomplete: true,
  "paste.largeMenuThreshold": true,
  "completion.notify": true,
  "error.notify": true,
  "recap.enabled": true,
  "recap.idleSeconds": true,
  "startup.quiet": true,
  "startup.showSplash": true,
  "startup.setupWizard": true,
  "startup.checkUpdate": true,
  "git.enabled": true,
};

afterEach(() => cleanup());

// Omp v18.9.1 defaults: modes/settings.ts:31-50, 694-1289; tools/settings.ts:294-342;
// collab/settings.ts:9-65; commands/settings.ts:8-57; session/settings.ts:39-62, 1052-1079;
// modes/magic-keywords.ts:70-107. Defaults stay in A1 ConfigStore at runtime.
const DEFAULT_VALUES: Readonly<Record<string, JsonValue>> = {
  autoResume: false,
  "git.enabled": true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  "tui.vimMode": false,
  "tui.vimModeDisplay": "text",
  "loop.mode": "prompt",
  "loop.conditionTimeoutMs": 30_000,
  "composer.predictions": false,
  "composer.recallClearedDrafts": true,
  doubleEscapeAction: "rewind",
  "input.bareExitOnEmptySession": true,
  "input.bareSlashCommands": false,
  treeFilterMode: "default",
  autocompleteMaxVisible: 10,
  "spelling.typoDetection": true,
  "spelling.autocomplete": "auto",
  "spelling.autocorrect": false,
  emojiAutocomplete: true,
  "paste.largeMenuThreshold": 100,
  "tools.approval": {},
  "tools.approvalMode": "yolo",
  "completion.notify": "on",
  "error.notify": "off",
  "ask.timeout": 0,
  "ask.notify": "on",
  "recap.enabled": true,
  "recap.idleSeconds": 240,
  "collab.relayUrl": "wss://my.omp.sh",
  "collab.webUrl": "",
  "collab.displayName": "",
  "collab.autoStart": "off",
  "share.serverUrl": "https://my.omp.sh/s",
  "share.store": "blob",
  "share.redactSecrets": true,
  "magicKeywords.enabled": true,
  "magicKeywords.ultrathink": true,
  "magicKeywords.orchestrate": true,
  "magicKeywords.workflow": true,
  "magicKeywords.jevify": true,
  "startup.quiet": false,
  "startup.showSplash": false,
  "startup.setupWizard": true,
  "startup.checkUpdate": true,
  "marketplace.autoUpdate": "notify",
  "startup.changelogMode": "summary",
  "update.channel": "stable",
  "power.sleepPrevention": "idle",
  "features.unexpectedStopDetection": "mechanical",
};

const EXPECTED_KEYS = {
  input: [
    "steeringMode",
    "followUpMode",
    "interruptMode",
    "tui.vimMode",
    "tui.vimModeDisplay",
    "loop.mode",
    "loop.conditionTimeoutMs",
    "composer.predictions",
    "composer.recallClearedDrafts",
    "doubleEscapeAction",
    "input.bareExitOnEmptySession",
    "input.bareSlashCommands",
    "treeFilterMode",
    "autocompleteMaxVisible",
    "spelling.typoDetection",
    "spelling.autocomplete",
    "spelling.autocorrect",
    "emojiAutocomplete",
    "paste.largeMenuThreshold",
  ],
  approvals: ["tools.approval", "tools.approvalMode"],
  notifications: [
    "completion.notify",
    "error.notify",
    "ask.timeout",
    "ask.notify",
    "recap.enabled",
    "recap.idleSeconds",
  ],
  collab: [
    "collab.relayUrl",
    "collab.webUrl",
    "collab.displayName",
    "collab.autoStart",
    "share.serverUrl",
    "share.store",
    "share.redactSecrets",
  ],
  magicKeywords: [
    "magicKeywords.enabled",
    "magicKeywords.ultrathink",
    "magicKeywords.orchestrate",
    "magicKeywords.workflow",
    "magicKeywords.jevify",
  ],
  startupUpdates: [
    "autoResume",
    "startup.quiet",
    "startup.showSplash",
    "startup.setupWizard",
    "startup.checkUpdate",
    "marketplace.autoUpdate",
    "startup.changelogMode",
    "update.channel",
  ],
  power: ["power.sleepPrevention"],
  agent: ["features.unexpectedStopDetection"],
  git: ["git.enabled"],
} as const;

const EXPECTED_KINDS: Readonly<Record<string, SettingControl["kind"]>> = {
  steeringMode: "enum",
  followUpMode: "enum",
  interruptMode: "enum",
  "tui.vimMode": "boolean",
  "tui.vimModeDisplay": "enum",
  "loop.mode": "enum",
  "loop.conditionTimeoutMs": "number",
  "composer.predictions": "boolean",
  "composer.recallClearedDrafts": "boolean",
  doubleEscapeAction: "enum",
  "input.bareExitOnEmptySession": "boolean",
  "input.bareSlashCommands": "boolean",
  treeFilterMode: "enum",
  autocompleteMaxVisible: "number",
  "spelling.typoDetection": "boolean",
  "spelling.autocomplete": "enum",
  "spelling.autocorrect": "boolean",
  emojiAutocomplete: "boolean",
  "paste.largeMenuThreshold": "number",
  "tools.approvalMode": "enum",
  "tools.approval": "map",
  "completion.notify": "enum",
  "error.notify": "enum",
  "ask.timeout": "number",
  "ask.notify": "enum",
  "recap.enabled": "boolean",
  "recap.idleSeconds": "number",
  "collab.relayUrl": "text",
  "collab.webUrl": "text",
  "collab.displayName": "text",
  "collab.autoStart": "enum",
  "share.serverUrl": "text",
  "share.store": "enum",
  "share.redactSecrets": "boolean",
  "magicKeywords.enabled": "boolean",
  "magicKeywords.ultrathink": "boolean",
  "magicKeywords.orchestrate": "boolean",
  "magicKeywords.workflow": "boolean",
  "magicKeywords.jevify": "boolean",
  autoResume: "boolean",
  "startup.quiet": "boolean",
  "startup.showSplash": "boolean",
  "startup.setupWizard": "boolean",
  "startup.checkUpdate": "boolean",
  "marketplace.autoUpdate": "enum",
  "startup.changelogMode": "enum",
  "update.channel": "enum",
  "power.sleepPrevention": "enum",
  "features.unexpectedStopDetection": "enum",
  "git.enabled": "boolean",
};

const APPLY_BOUNDARIES: Readonly<Record<string, SettingControl["apply"]>> = {
  steeringMode: "live",
  followUpMode: "live",
  interruptMode: "live",
  "tui.vimMode": "live",
  "tui.vimModeDisplay": "live",
  "loop.mode": "live",
  "loop.conditionTimeoutMs": "live",
  "composer.predictions": "live",
  "composer.recallClearedDrafts": "live",
  doubleEscapeAction: "live",
  "input.bareExitOnEmptySession": "live",
  "input.bareSlashCommands": "live",
  treeFilterMode: "live",
  autocompleteMaxVisible: "live",
  "spelling.typoDetection": "live",
  "spelling.autocomplete": "live",
  "spelling.autocorrect": "live",
  emojiAutocomplete: "live",
  "paste.largeMenuThreshold": "live",
  "tools.approvalMode": "live",
  "tools.approval": "live",
  "completion.notify": "live",
  "error.notify": "live",
  "ask.timeout": "live",
  "ask.notify": "live",
  "recap.enabled": "live",
  "recap.idleSeconds": "live",
  "collab.relayUrl": "live",
  "collab.webUrl": "live",
  "collab.displayName": "live",
  "collab.autoStart": "session",
  "share.serverUrl": "live",
  "share.store": "live",
  "share.redactSecrets": "live",
  "magicKeywords.enabled": "live",
  "magicKeywords.ultrathink": "live",
  "magicKeywords.orchestrate": "live",
  "magicKeywords.workflow": "live",
  "magicKeywords.jevify": "live",
  autoResume: "restart",
  "startup.quiet": "restart",
  "startup.showSplash": "restart",
  "startup.setupWizard": "restart",
  "startup.checkUpdate": "restart",
  "marketplace.autoUpdate": "restart",
  "startup.changelogMode": "restart",
  "update.channel": "restart",
  "power.sleepPrevention": "live",
  "features.unexpectedStopDetection": "live",
  "git.enabled": "live",
};

function defaultSnapshot(descriptor: SettingsSectionDescriptor): ConfigSnapshot {
  const entries: ConfigEntry[] = descriptor.controls.map((setting) => {
    const value = DEFAULT_VALUES[setting.key];
    if (value === undefined) throw new Error(`Missing v18.9.1 default fixture for ${setting.key}.`);
    return { key: setting.key, secret: false, value, source: "default", overrides: [] };
  });
  return { folder: null, revision: "revision-1", entries };
}

function sectionValues(settings: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, setting]) => {
      const projected = setting as InteractionSetting<unknown>;
      return [key, projected.secret ? { secret: true, isSet: projected.isSet } : projected.value];
    }),
  );
}

function expectDefaultProvenance(settings: object): void {
  for (const setting of Object.values(settings) as InteractionSetting<unknown>[]) {
    expect(setting.secret).toBe(false);
    if (!setting.secret) expect(setting).toMatchObject({ source: "default", overrides: [] });
  }
}

function control(key: string): SettingControl {
  const found = S1_INTERACTION_SECTIONS.flatMap((descriptor) => descriptor.controls).find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`Missing interaction setting ${key}.`);
  return found;
}

function interactionDefaults() {
  return projectInteractionSettingsSnapshot(interactionConfigDefaults());
}

describe("S1.4 interaction settings sections", () => {
  test("claims all nine owned rows and every v18.9.1 Interaction key exactly once", () => {
    const descriptors = S1_INTERACTION_SECTIONS;
    const keys = descriptors.flatMap((descriptor) =>
      descriptor.controls.map((setting) => setting.key),
    );
    const ownedKeys = Object.values(EXPECTED_KEYS).flat();
    const sections = new Set(descriptors.map((descriptor) => descriptor.section));

    expect(sections.size).toBe(9);
    expect(keys).toHaveLength(50);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...ownedKeys].sort());
    expect(descriptors.flatMap((descriptor) => descriptor.inventory)).toEqual([
      "S3.interaction-input",
      "S3.interaction-approvals",
      "S3.interaction-notifications",
      "S3.interaction-collab",
      "S3.interaction-magic-keywords",
      "S3.interaction-startup-updates",
      "S3.interaction-power",
      "S3.interaction-agent",
      "S3.interaction-git",
    ]);
    expect(keys).not.toContain("skills.enableSkillCommands");
    expect(keys).not.toContain("collab.stream");
    expect(keys).not.toContain("speech.enabled");
  });

  test("marks every S1 terminal-only control and keeps Auto Resume available to the app", () => {
    const controls = new Map(
      S1_INTERACTION_SECTIONS.flatMap((descriptor) =>
        descriptor.controls.map((setting) => [setting.key, setting] as const),
      ),
    );
    for (const key of Object.keys(TERMINAL_ONLY_DESCRIPTION_KEYS)) {
      expect(controls.get(key)?.description, key).toMatch(/^Terminal only\./);
    }
    expect(Object.hasOwn(TERMINAL_ONLY_DESCRIPTION_KEYS, "autoResume")).toBe(false);
    expect(controls.get("autoResume")?.description).not.toMatch(/^Terminal only\./);
  });

  test("explains approval choices and uses one plain policy label", () => {
    expect(APPROVALS_SECTION.title).toBe("Approvals");
    const mode = control("tools.approvalMode");
    expect(mode.label).toBe("Approval Mode");
    expect(mode.description).toBe(
      OMP_DESCRIPTION_ROWS.find((row) => row.key === "tools.approvalMode")?.description,
    );
    const policies = control("tools.approval");
    if (policies.kind !== "map") throw new Error("Expected the approval policy map.");
    expect(policies.value.options).toContainEqual({ value: "prompt", label: "Ask first" });
    expect(policies.description).toBe(
      OMP_DESCRIPTION_ROWS.find((row) => row.key === "tools.approval")?.description,
    );
  });

  test("matches every interaction control to the literal omp source table", () => {
    const controls = S1_INTERACTION_SECTIONS.flatMap((descriptor) => descriptor.controls);
    const actualKeys = controls.map((setting) => setting.key).sort();
    const sourceKeys = OMP_DESCRIPTION_ROWS.map((row) => row.key).sort();
    expect(OMP_DESCRIPTION_ROWS).toHaveLength(50);
    expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
    expect(actualKeys).toEqual(sourceKeys);

    for (const row of OMP_DESCRIPTION_ROWS) {
      const setting = control(row.key);
      expect(row.source, row.key).toContain(":");
      if (Object.hasOwn(TERMINAL_ONLY_DESCRIPTION_KEYS, row.key)) {
        expect(setting.description, `${row.key} (${row.source})`).toMatch(/^Terminal only\./);
      } else {
        expect(setting.description, `${row.key} (${row.source})`).toBe(row.description);
      }
    }
  });

  test("uses the source setting type and apply boundary for every key", () => {
    const descriptors = S1_INTERACTION_SECTIONS;
    for (const descriptor of descriptors) {
      const snapshot = defaultSnapshot(descriptor);
      expect(descriptor.requires).toContain("host.config");
      for (const setting of descriptor.controls) {
        expect(setting.secret).toBe(false);
        expect(setting.kind).toBe(EXPECTED_KINDS[setting.key]);
        expect(setting.apply).toBe(APPLY_BOUNDARIES[setting.key]);
        const value = DEFAULT_VALUES[setting.key];
        if (value === undefined) throw new Error(`Missing default fixture for ${setting.key}.`);
        expect(setting.validate({ secret: false, value }, snapshot)).toEqual({ valid: true });
      }
    }
    expect(POWER_SETTINGS_SECTION.requires).toEqual(["host.config"]);
    expect(GIT_SETTINGS_SECTION.requires).toEqual(["host.config"]);
  });

  test("projects ConfigStore defaults as typed values without losing provenance", () => {
    const snapshot = interactionDefaults();

    expect(sectionValues(snapshot.input.settings)).toEqual({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      interruptMode: "immediate",
      vimMode: false,
      vimModeDisplay: "text",
      loopMode: "prompt",
      loopConditionTimeoutMs: 30_000,
      composerPredictions: false,
      recallClearedDrafts: true,
      doubleEscapeAction: "rewind",
      bareExitOnEmptySession: true,
      bareSlashCommands: false,
      treeFilterMode: "default",
      autocompleteMaxVisible: 10,
      typoDetection: true,
      spellingAutocomplete: "auto",
      autocorrect: false,
      emojiAutocomplete: true,
      largePasteMenuThreshold: 100,
    });
    expect(sectionValues(snapshot.approvals.mode.settings)).toEqual({ mode: "yolo" });
    expect(sectionValues(snapshot.approvals.policies.settings)).toEqual({ policies: {} });
    expect(sectionValues(snapshot.notifications.settings)).toEqual({
      completionNotify: "on",
      errorNotify: "off",
      askTimeout: 0,
      askNotify: "on",
      recapEnabled: true,
      recapIdleSeconds: 240,
    });
    expect(sectionValues(snapshot.collaboration.settings)).toEqual({
      relayUrl: "wss://my.omp.sh",
      webUrl: "",
      displayName: "",
      autoStart: "off",
      shareServerUrl: "https://my.omp.sh/s",
      shareStore: "blob",
      redactShareSecrets: true,
    });
    expect(sectionValues(snapshot.magicKeywords.settings)).toEqual({
      enabled: true,
      ultrathink: true,
      orchestrate: true,
      workflow: true,
      jevify: true,
    });
    expect(sectionValues(snapshot.startupUpdates.settings)).toEqual({
      autoResume: false,
      quiet: false,
      showSplash: false,
      setupWizard: true,
      checkUpdate: true,
      marketplaceAutoUpdate: "notify",
      changelogMode: "summary",
      updateChannel: "stable",
    });
    expect(sectionValues(snapshot.power.settings)).toEqual({ sleepPrevention: "idle" });
    expect(sectionValues(snapshot.agent.settings)).toEqual({
      unexpectedStopDetection: "mechanical",
    });
    expect(sectionValues(snapshot.git.settings)).toEqual({ enabled: true });

    for (const section of [
      snapshot.input,
      snapshot.approvals.mode,
      snapshot.approvals.policies,
      snapshot.notifications,
      snapshot.collaboration,
      snapshot.magicKeywords,
      snapshot.startupUpdates,
      snapshot.power,
      snapshot.agent,
      snapshot.git,
    ]) {
      expectDefaultProvenance(section.settings);
    }
  });

  test("retains non-default source/overrides and rejects malformed consumer snapshots", () => {
    const original = defaultSnapshot(INPUT_SETTINGS_SECTION);
    const entries = original.entries.map((candidate) => {
      if (candidate.key !== "steeringMode") return candidate;
      return {
        ...candidate,
        source: "project" as const,
        overrides: ["global", "default"] as ConfigEntry["overrides"],
      };
    });
    const projected = projectInteractionSettingsSnapshot({
      ...interactionConfigDefaults(),
      input: { ...original, entries },
    });
    expect(projected.input.settings.steeringMode).toMatchObject({
      secret: false,
      value: "one-at-a-time",
      source: "project",
      overrides: ["global", "default"],
    });

    const invalidEntries = original.entries.map((candidate) =>
      candidate.key === "steeringMode" ? { ...candidate, value: "later" } : candidate,
    );
    expect(() =>
      projectInteractionSettingsSnapshot({
        ...interactionConfigDefaults(),
        input: { ...original, entries: invalidEntries },
      }),
    ).toThrow("Invalid effective value for interaction setting steeringMode");
  });

  test("projects effective values by type without applying write-only bounds", () => {
    const input = defaultSnapshot(INPUT_SETTINGS_SECTION);
    const inputEntries = input.entries.map((entry) =>
      entry.key === "autocompleteMaxVisible" ? { ...entry, value: 25 } : entry,
    );
    const collab = defaultSnapshot(COLLAB_SETTINGS_SECTION);
    const collabEntries = collab.entries.map((entry) =>
      entry.key === "share.serverUrl"
        ? { ...entry, value: "https://share.example.com/base?team=1" }
        : entry,
    );
    const projected = projectInteractionSettingsSnapshot({
      ...interactionConfigDefaults(),
      input: { ...input, entries: inputEntries },
      collab: { ...collab, entries: collabEntries },
    });
    expect(projected.input.settings.autocompleteMaxVisible).toMatchObject({ value: 25 });
    expect(projected.collaboration.settings.shareServerUrl).toMatchObject({
      value: "https://share.example.com/base?team=1",
    });
  });

  test("edits per-tool approval policies through the kit's enum-valued map control", () => {
    const base = defaultSnapshot(APPROVALS_SECTION);
    const configured: ConfigEntry = {
      key: "tools.approval",
      secret: false,
      value: { bash: "allow", task: "prompt" },
      source: "global",
      overrides: ["default"],
    };
    const snapshot = {
      ...base,
      entries: base.entries.map((candidate) =>
        candidate.key === "tools.approval" ? configured : candidate,
      ),
    };
    const policies = control("tools.approval");
    if (policies.kind !== "map") throw new Error("Tool approval policies must use the map editor.");

    expect(TOOL_APPROVAL_POLICY_VALUES).toEqual(["allow", "prompt", "deny"]);
    expect(policies.value).toMatchObject({
      label: "Policy",
      kind: "enum",
      options: [
        { value: "allow", label: "Allow" },
        { value: "prompt", label: "Ask first" },
        { value: "deny", label: "Deny" },
      ],
    });
    expect(policies.validate({ secret: false, value: configured.value }, snapshot)).toEqual({
      valid: true,
    });
    expect(
      policies.validate({ secret: false, value: { bash: "unknown" } }, snapshot),
    ).toMatchObject({
      valid: false,
      code: "policy",
    });

    render(<SettingsSection descriptor={APPROVALS_SECTION} snapshot={snapshot} />);
    expect(screen.getByLabelText("Tool Approval Policies: Tool name 1")).toHaveProperty(
      "value",
      "bash",
    );
    expect(screen.getByLabelText("Tool Approval Policies: Policy 1")).toHaveProperty(
      "value",
      "allow",
    );
    expect(screen.getByLabelText("Tool Approval Policies: Tool name 2")).toHaveProperty(
      "value",
      "task",
    );
    expect(screen.getByLabelText("Tool Approval Policies: Policy 2")).toHaveProperty(
      "value",
      "prompt",
    );
    expect(
      screen.getByText("Source: Saved for all projects · overrides omp's default"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add tool policy" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("keeps redacted approval records value-free in consumer snapshots", () => {
    const redacted: ConfigEntry = {
      key: "tools.approval",
      secret: true,
      isSet: true,
      source: "global",
      overrides: ["default"],
    };
    const approvals = defaultSnapshot(APPROVALS_SECTION);
    const approvalSnapshot = {
      ...approvals,
      entries: approvals.entries.map((candidate) =>
        candidate.key === "tools.approval" ? redacted : candidate,
      ),
    };
    const projected = projectInteractionSettingsSnapshot({
      ...interactionConfigDefaults(),
      approvals: approvalSnapshot,
    });
    const policies = projected.approvals.policies.settings.policies;
    expect(policies).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect("value" in policies).toBe(false);
    expect(JSON.stringify(policies)).not.toContain("value");

    const input = defaultSnapshot(INPUT_SETTINGS_SECTION);

    expect(control("steeringMode").validate({ secret: false, value: "later" }, input).valid).toBe(
      false,
    );
    expect(
      control("loop.conditionTimeoutMs").validate({ secret: false, value: -1 }, input).valid,
    ).toBe(false);
    expect(
      control("spelling.autocomplete").validate({ secret: false, value: "missing" }, input).valid,
    ).toBe(false);
  });
  test("accepts empty optional relay and derived URL settings as omp defaults", () => {
    const snapshot = defaultSnapshot(COLLAB_SETTINGS_SECTION);
    for (const key of ["collab.webUrl", "share.serverUrl"]) {
      expect(control(key).validate({ secret: false, value: "" }, snapshot), key).toEqual({
        valid: true,
      });
    }
    expect(
      control("collab.relayUrl").validate({ secret: false, value: "" }, snapshot),
    ).toMatchObject({
      valid: false,
      code: "url",
    });
  });
});

function interactionConfigDefaults() {
  return {
    input: defaultSnapshot(INPUT_SETTINGS_SECTION),
    approvals: defaultSnapshot(APPROVALS_SECTION),
    notifications: defaultSnapshot(NOTIFICATIONS_SETTINGS_SECTION),
    collab: defaultSnapshot(COLLAB_SETTINGS_SECTION),
    magicKeywords: defaultSnapshot(MAGIC_KEYWORDS_SETTINGS_SECTION),
    startupUpdates: defaultSnapshot(STARTUP_UPDATES_SETTINGS_SECTION),
    power: defaultSnapshot(POWER_SETTINGS_SECTION),
    agent: defaultSnapshot(AGENT_SETTINGS_SECTION),
    git: defaultSnapshot(GIT_SETTINGS_SECTION),
  };
}
