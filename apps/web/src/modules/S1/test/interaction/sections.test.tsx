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

afterEach(() => cleanup());

// omp v18.6.1 defaults: modes/settings.ts:29-50, 694-1216; tools/settings.ts:294-333;
// collab/settings.ts:9-69; commands/settings.ts:8-55; session/settings.ts:37-56, 1011-1035;
// packages/wire/src/index.ts:426,429. Defaults stay in A1 ConfigStore at runtime.
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
  steeringMode: "session",
  followUpMode: "session",
  interruptMode: "session",
  "tui.vimMode": "live",
  "tui.vimModeDisplay": "live",
  "loop.mode": "live",
  "loop.conditionTimeoutMs": "live",
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
  "features.unexpectedStopDetection": "session",
  "git.enabled": "live",
};

function defaultSnapshot(descriptor: SettingsSectionDescriptor): ConfigSnapshot {
  const entries: ConfigEntry[] = descriptor.controls.map((setting) => {
    const value = DEFAULT_VALUES[setting.key];
    if (value === undefined) throw new Error(`Missing v18.6.1 default fixture for ${setting.key}.`);
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
  test("claims all nine owned rows and every v18.6.1 Interaction key exactly once", () => {
    const descriptors = S1_INTERACTION_SECTIONS;
    const keys = descriptors.flatMap((descriptor) =>
      descriptor.controls.map((setting) => setting.key),
    );
    const ownedKeys = Object.values(EXPECTED_KEYS).flat();
    const sections = new Set(descriptors.map((descriptor) => descriptor.section));

    expect(sections.size).toBe(9);
    expect(keys).toHaveLength(49);
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
    expect(POWER_SETTINGS_SECTION.requires).toContain("host.power");
    expect(GIT_SETTINGS_SECTION.requires).toContain("host.git");
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
        { value: "prompt", label: "Prompt" },
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
