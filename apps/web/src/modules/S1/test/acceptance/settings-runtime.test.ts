import type { ConfigChanged, ConfigEntry, ConfigWriteResult, Revision } from "@omp-app/contracts";
import { AppFailure, ConfigWriteArgs } from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SETTINGS_SECTIONS } from "@/registry";
import { stageContextSetting } from "../../../P7/settings/stage-context-setting";
import { SHELL_EVAL_RUNTIMES_SECTION } from "../../../S2/sections";
import { THEME_SETTINGS_SECTION } from "../../appearance";
import { S1_SETTINGS_SECTIONS } from "../../descriptors";
import {
  S1_CONFIG_LIST_FIXTURE,
  S1_PROJECT_FOLDER,
  S1_SECRET_STATUS_FIXTURES,
  S1_SECTION_CONFIG_FIXTURES,
  S1_SETTING_INVENTORY_ROWS,
} from "../../fixtures";
import {
  INPUT_SETTINGS_SECTION,
  NOTIFICATIONS_SETTINGS_SECTION,
  STARTUP_UPDATES_SETTINGS_SECTION,
} from "../../interaction";
import { SettingsRuntime } from "../../runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
} from "../../settings-kit";
import { readSection } from "../../settings-kit";

type FakeConfig = {
  entries: ConfigEntry[];
  revision: Revision;
  writes: ConfigWriteArgs[];
  listFolders: Array<string | null>;
  listeners: Set<(change: ConfigChanged) => void>;
  writeGate?: Promise<void>;
  conflictNextWrite: boolean;
  /** Environment variables that supply a written key's value, by key: the write then reports that source. */
  environmentKeys?: Readonly<Record<string, string>>;
};

const liveRuntimes: SettingsRuntime[] = [];

afterEach(() => {
  for (const runtime of liveRuntimes.splice(0)) runtime.dispose();
});

function fakeConfig(): FakeConfig {
  return {
    entries: [...S1_CONFIG_LIST_FIXTURE.entries],
    revision: S1_CONFIG_LIST_FIXTURE.revision,
    writes: [],
    listFolders: [],
    listeners: new Set(),
    conflictNextWrite: false,
  };
}

function updateEntry(state: FakeConfig, entry: ConfigEntry): void {
  const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
  if (index < 0) state.entries.push(entry);
  else state.entries[index] = entry;
}

function fakeClient(state: FakeConfig): ConfigStoreClient {
  return {
    async read({ key }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        throw new AppFailure({
          code: "not_found",
          message: `Configuration key ${key} was not found.`,
          retryable: false,
        });
      }
      return entry;
    },
    async list({ folder }) {
      state.listFolders.push(folder);
      return { entries: [...state.entries], revision: state.revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgs.parse(input);
      state.writes.push(args);
      if (state.writeGate) await state.writeGate;
      const previousRevision = state.revision;
      if (state.conflictNextWrite) {
        state.conflictNextWrite = false;
        state.revision = `s1-conflict-${state.writes.length}` as Revision;
        const remoteEntry: ConfigEntry = {
          key: args.key,
          secret: false,
          value: args.key === "theme.dark" ? "remote-theme" : "one-at-a-time",
          source: "project",
          overrides: ["global", "default"],
        };
        updateEntry(state, remoteEntry);
        throw new AppFailure({
          code: "conflict",
          message: "Configuration changed elsewhere.",
          retryable: true,
        });
      }
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Configuration changed elsewhere.",
          retryable: true,
        });
      }
      const overrides: ConfigEntry["overrides"] =
        args.layer === "project" ? ["global", "default"] : ["default"];
      state.revision = `s1-project-config-${state.writes.length + 1}` as Revision;
      const entry: ConfigEntry = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer,
            overrides,
          }
        : {
            key: args.key,
            secret: false,
            value: args.value.value,
            ...writtenSource(state, args.key, args.layer),
            overrides,
          };
      updateEntry(state, entry);
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        previousRevision,
        revision: state.revision,
        entry,
      };
    },
  };
}

function changeSource(state: FakeConfig): ConfigChangeSource {
  return {
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
}

/** Where a written value comes from: the environment variable that supplies the key, when the test marks one. */
function writtenSource(
  state: FakeConfig,
  key: string,
  layer: ConfigWriteArgs["layer"],
): Pick<ConfigEntry, "source"> & { readonly overriddenBy?: string } {
  const variable = state.environmentKeys?.[key];
  return variable === undefined ? { source: layer } : { source: "env", overriddenBy: variable };
}

function runtimeFor(state: FakeConfig, descriptor: SettingsSectionDescriptor): SettingsRuntime {
  const runtime = new SettingsRuntime(fakeClient(state), changeSource(state), {
    descriptor,
    folder: S1_PROJECT_FOLDER,
    layer: "project",
  });
  liveRuntimes.push(runtime);
  return runtime;
}

function entryFor(snapshot: ConfigSnapshot, key: string): ConfigEntry {
  const entry = snapshot.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing fixture entry ${key}.`);
  return entry;
}

function controlFor(descriptor: SettingsSectionDescriptor, key: string): SettingControl {
  const control = descriptor.controls.find((candidate) => candidate.key === key);
  if (!control) throw new Error(`Missing settings control ${key}.`);
  return control;
}

function readValue(entry: ConfigEntry): SettingValue {
  return entry.secret ? { secret: true, action: "unset" } : { secret: false, value: entry.value };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("S1.5 ConfigStore fixture and grammar gate", () => {
  test("provides a valid ConfigStore snapshot for every S1-owned setting section and key", async () => {
    const state = fakeConfig();
    const client = fakeClient(state);
    expect(S1_SECTION_CONFIG_FIXTURES.map((fixture) => fixture.sectionId)).toEqual(
      S1_SETTINGS_SECTIONS.map((section) => section.id),
    );
    expect(S1_SECTION_CONFIG_FIXTURES.map((fixture) => fixture.inventoryId)).toEqual(
      S1_SETTING_INVENTORY_ROWS,
    );
    const snapshots = await Promise.all(
      S1_SETTINGS_SECTIONS.map((descriptor) => readSection(client, descriptor, S1_PROJECT_FOLDER)),
    );
    const keys = snapshots.flatMap((snapshot) => snapshot.entries.map((entry) => entry.key));

    expect(snapshots).toHaveLength(14);
    expect(keys).toHaveLength(S1_CONFIG_LIST_FIXTURE.entries.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(
      [...S1_CONFIG_LIST_FIXTURE.entries.map((entry) => entry.key)].sort(),
    );
    for (const [index, descriptor] of S1_SETTINGS_SECTIONS.entries()) {
      const snapshot = snapshots[index];
      if (!snapshot) throw new Error(`Missing snapshot for ${descriptor.id}.`);
      expect(snapshot.folder).toBe(S1_PROJECT_FOLDER);
      expect(snapshot.entries).toHaveLength(descriptor.controls.length);
      for (const control of descriptor.controls) {
        expect(control.validate(readValue(entryFor(snapshot, control.key)), snapshot)).toEqual({
          valid: true,
        });
      }
    }
    expect(state.listFolders).toEqual(S1_SETTINGS_SECTIONS.map(() => S1_PROJECT_FOLDER));
  });

  test("no config key or section id is owned by two settings sections across modules", () => {
    // The registry's one section list holds every module's sections: two sections claiming one
    // omp key would render two competing controls.
    const owners = new Map<string, string[]>();
    for (const section of SETTINGS_SECTIONS) {
      for (const control of section.controls) {
        owners.set(control.key, [...(owners.get(control.key) ?? []), section.id]);
      }
    }
    const sharedKeys = [...owners].filter(([, ids]) => ids.length > 1);
    expect(sharedKeys).toEqual([]);
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("rejects invalid enum, number and path values through the shared validators", () => {
    const state = fakeConfig();
    const inputConfig: ConfigSnapshot = {
      folder: S1_PROJECT_FOLDER,
      revision: state.revision,
      entries: [...S1_CONFIG_LIST_FIXTURE.entries],
    };
    const notificationsConfig: ConfigSnapshot = {
      ...inputConfig,
      entries: inputConfig.entries.filter((entry) =>
        NOTIFICATIONS_SETTINGS_SECTION.controls.some((control) => control.key === entry.key),
      ),
    };
    const shellRuntimesConfig: ConfigSnapshot = {
      ...inputConfig,
      entries: inputConfig.entries.filter((entry) =>
        SHELL_EVAL_RUNTIMES_SECTION.controls.some((control) => control.key === entry.key),
      ),
    };

    expect(
      controlFor(INPUT_SETTINGS_SECTION, "steeringMode").validate(
        { secret: false, value: "invalid-mode" },
        inputConfig,
      ),
    ).toMatchObject({ valid: false, code: "enum" });
    expect(
      controlFor(NOTIFICATIONS_SETTINGS_SECTION, "ask.timeout").validate(
        { secret: false, value: -1 },
        notificationsConfig,
      ),
    ).toMatchObject({ valid: false, code: "range" });
    expect(
      controlFor(SHELL_EVAL_RUNTIMES_SECTION, "python.interpreter").validate(
        { secret: false, value: "\0" },
        shellRuntimesConfig,
      ),
    ).toMatchObject({ valid: false });
  });

  test("stages without writing, then saves one live key with its expected revision", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state, THEME_SETTINGS_SECTION);
    await runtime.read();
    const startingSnapshot = runtime.getSnapshot().config;
    if (!startingSnapshot) throw new Error("Theme fixture did not load.");
    const startingValue = entryFor(startingSnapshot, "theme.dark");

    expect(runtime.stage("theme.dark", { secret: false, value: "custom-theme" }).ok).toBe(true);
    expect(runtime.preview("theme.dark")).toEqual({ ok: true, patch: null });
    expect(state.writes).toHaveLength(0);
    runtime.cancel();
    expect(state.writes).toHaveLength(0);
    const cancelledSnapshot = runtime.getSnapshot().config;
    if (!cancelledSnapshot) throw new Error("Theme fixture disappeared after cancel.");
    expect(entryFor(cancelledSnapshot, "theme.dark")).toEqual(startingValue);

    expect(runtime.stage("theme.dark", { secret: false, value: "custom-theme" }).ok).toBe(true);
    await runtime.save();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      key: "theme.dark",
      layer: "project",
      folder: S1_PROJECT_FOLDER,
      expectedRevision: S1_CONFIG_LIST_FIXTURE.revision,
      value: { secret: false, value: "custom-theme" },
    });
    expect(runtime.getSnapshot().applyStatus).toBe("applied");
  });
  test("keeps stages refused during a save and applies both values after it finishes", async () => {
    const state = fakeConfig();
    const gate = Promise.withResolvers<void>();
    state.writeGate = gate.promise;
    const runtime = runtimeFor(state, THEME_SETTINGS_SECTION);
    await runtime.read();
    expect(runtime.stage("theme.dark", { secret: false, value: "custom-theme" }).ok).toBe(true);
    const saving = runtime.save();
    await Promise.resolve();
    expect(runtime.getSnapshot().phase).toBe("saving");

    const first = { secret: false as const, value: "during-save-dark" };
    const second = { secret: false as const, value: "during-save-light" };
    stageContextSetting(runtime, "theme.dark", first);
    stageContextSetting(runtime, "theme.light", second);
    expect(runtime.getSnapshot().phase).toBe("saving");
    expect(state.writes[0]?.value).toEqual({ secret: false, value: "custom-theme" });

    gate.resolve();
    await saving;
    await Promise.resolve();
    expect(runtime.getSnapshot().phase).toBe("editing");
    expect(runtime.getSnapshot().staged?.edits).toEqual({
      "theme.dark": first,
      "theme.light": second,
    });
  });

  test("reports restart-required apply status from the same runtime", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state, STARTUP_UPDATES_SETTINGS_SECTION);
    await runtime.read();
    expect(runtime.stage("autoResume", { secret: false, value: true }).ok).toBe(true);
    await runtime.save();
    expect(runtime.getSnapshot().applyStatus).toBe("restart-required");
  });
  test("reports session-only apply status for session-owned controls", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state, INPUT_SETTINGS_SECTION);
    await runtime.read();
    expect(runtime.stage("steeringMode", { secret: false, value: "all" }).ok).toBe(true);
    await runtime.save();
    expect(runtime.getSnapshot().applyStatus).toBe("session-only");
  });

  test("sets and unsets secrets through status-only ConfigStore entries", async () => {
    const state = fakeConfig();
    const unsetFixture = S1_SECRET_STATUS_FIXTURES.find((entry) => !entry.isSet);
    if (!unsetFixture) throw new Error("Missing unset-secret fixture.");
    state.entries.push(unsetFixture);
    const secretDescriptor: SettingsSectionDescriptor = {
      id: "S1.acceptanceSecretProbe",
      section: "appearance/Theme",
      title: "Secret boundary fixture",
      inventory: [],
      requires: ["host.config"],
      controls: [
        {
          key: unsetFixture.key,
          label: "Fixture secret",
          kind: "secret",
          secret: true,
          validate: () => ({ valid: true }),
          apply: "restart",
        },
      ],
    };
    const runtime = runtimeFor(state, secretDescriptor);
    await runtime.read();
    const secretValue = ["S1", "fixture", "credential"].join("-");

    expect(
      runtime.stage(unsetFixture.key, { secret: true, action: "set", value: secretValue }).ok,
    ).toBe(true);
    await runtime.save();
    const setSnapshot = runtime.getSnapshot().config;
    if (!setSnapshot) throw new Error("Secret ConfigStore snapshot disappeared after set.");
    const setEntry = entryFor(setSnapshot, unsetFixture.key);
    if (!setEntry.secret) throw new Error("Secret set did not return status-only data.");
    expect(setEntry.isSet).toBe(true);
    expect("value" in setEntry).toBe(false);
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain(secretValue);
    expect(state.writes[0]?.value).toMatchObject({
      secret: true,
      action: "set",
      value: secretValue,
    });

    expect(runtime.stage(unsetFixture.key, { secret: true, action: "unset" }).ok).toBe(true);
    await runtime.save();
    const unsetSnapshot = runtime.getSnapshot().config;
    if (!unsetSnapshot) throw new Error("Secret ConfigStore snapshot disappeared after unset.");
    const unsetEntry = entryFor(unsetSnapshot, unsetFixture.key);
    if (!unsetEntry.secret) throw new Error("Secret unset did not return status-only data.");
    expect(unsetEntry.isSet).toBe(false);
    expect("value" in unsetEntry).toBe(false);
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain(secretValue);
  });

  test("preserves local edits on stale CAS and external change conflicts", async () => {
    const staleState = fakeConfig();
    staleState.conflictNextWrite = true;
    const staleRuntime = runtimeFor(staleState, INPUT_SETTINGS_SECTION);
    await staleRuntime.read();
    expect(staleRuntime.stage("steeringMode", { secret: false, value: "all" }).ok).toBe(true);
    await expect(staleRuntime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(staleRuntime.getSnapshot().phase).toBe("conflict");
    expect(staleRuntime.getSnapshot().conflict?.local.edits).toEqual({
      steeringMode: { secret: false, value: "all" },
    });

    const changedState = fakeConfig();
    const changedRuntime = runtimeFor(changedState, INPUT_SETTINGS_SECTION);
    await changedRuntime.read();
    expect(changedRuntime.stage("steeringMode", { secret: false, value: "all" }).ok).toBe(true);
    const remoteRevision = "s1-external-revision" as Revision;
    const remoteEntry: ConfigEntry = {
      key: "steeringMode",
      secret: false,
      value: "one-at-a-time",
      source: "project",
      overrides: ["global", "default"],
    };
    updateEntry(changedState, remoteEntry);
    changedState.revision = remoteRevision;
    const change: ConfigChanged = {
      key: "steeringMode",
      layer: "project",
      folder: S1_PROJECT_FOLDER,
      revision: remoteRevision,
      entry: remoteEntry,
    };
    for (const listener of changedState.listeners) listener(change);
    await settle();
    expect(changedRuntime.getSnapshot().phase).toBe("conflict");
    expect(changedRuntime.getSnapshot().conflict?.changedKeys).toEqual(["steeringMode"]);
  });
});

describe("S1 settings runtime after a save the environment overrides", () => {
  test("reports the variable that overrides the saved setting", async () => {
    const state = fakeConfig();
    state.environmentKeys = { "theme.dark": "PI_THEME_DARK" };
    const runtime = runtimeFor(state, THEME_SETTINGS_SECTION);
    await runtime.read();
    expect(runtime.stage("theme.dark", { secret: false, value: "custom-theme" }).ok).toBe(true);
    await runtime.save();
    expect(runtime.getSnapshot().environmentOverride).toEqual({ variables: ["PI_THEME_DARK"] });
  });
});
