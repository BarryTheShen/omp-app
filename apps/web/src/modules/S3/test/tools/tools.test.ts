import {
  AppFailure,
  type ConfigEntry,
  type ConfigSource,
  type ConfigWriteResult,
  FolderPath,
  JsonValue,
  type SettingSource,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigStoreClient } from "../../../S1/settings-kit";
import {
  projectToolsPolicy,
  readToolsSettings,
  stageToolsSetting,
  TOOLS_APPROVAL_DEFAULTS,
  TOOLS_POLICY_CONFIG_KEYS,
  TOOLS_SETTING_DEFAULTS,
  TOOLS_SETTINGS_SECTIONS,
  type ToolsConfigSnapshot,
  ToolsSettingsStore,
} from "../../tools";

type FakeConfigStore = {
  revision: string;
  revisionIndex: number;
  entries: ConfigEntry[];
  listFolders: (string | null)[];
  writes: Parameters<ConfigStoreClient["write"]>[0][];
};

function configValue(
  key: string,
  value: JsonValue,
  source: ConfigSource = "global",
  overrides: readonly SettingSource[] = [],
): ConfigEntry {
  return { key, secret: false, value, source, overrides: [...overrides] };
}

function configSecret(key: string, isSet: boolean, source: ConfigSource = "global"): ConfigEntry {
  return { key, secret: true, isSet, source, overrides: [] };
}

function fakeConfigStore(entries: readonly ConfigEntry[] = []): {
  readonly state: FakeConfigStore;
  readonly client: ConfigStoreClient;
} {
  const state: FakeConfigStore = {
    revision: "revision-1",
    revisionIndex: 1,
    entries: [...entries],
    listFolders: [],
    writes: [],
  };
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (entry) return entry;
      throw new AppFailure({ code: "not_found", message: "Setting not found.", retryable: false });
    },
    list: async ({ folder }) => {
      state.listFolders.push(folder);
      return { entries: [...state.entries], revision: state.revision };
    },
    write: async (args): Promise<ConfigWriteResult> => {
      state.writes.push(args);
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere. Reload before saving again.",
          retryable: true,
        });
      }
      state.revisionIndex += 1;
      state.revision = `revision-${state.revisionIndex}`;
      const entry: ConfigEntry = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer,
            overrides: [],
          }
        : {
            key: args.key,
            secret: false,
            value: JsonValue.parse(args.value.value),
            source: args.layer,
            overrides: [],
          };
      const index = state.entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder === null ? null : FolderPath.parse(args.folder),
        revision: state.revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
  return { state, client };
}

describe("S3 Tools ConfigStore policy", () => {
  test("matches each registered scalar control to its typed default", () => {
    const controls = TOOLS_SETTINGS_SECTIONS.flatMap((section) => section.controls);
    const controlKeys = controls.map((control) => control.key);
    expect(new Set(controlKeys).size).toBe(controlKeys.length);
    expect([...controlKeys].sort()).toEqual(Object.keys(TOOLS_SETTING_DEFAULTS).sort());

    for (const [key, value] of Object.entries(TOOLS_SETTING_DEFAULTS)) {
      const control = controls.find((candidate) => candidate.key === key);
      if (!control) throw new Error(`Missing Tools control for ${key}`);
      switch (control.kind) {
        case "boolean":
          expect(typeof value).toBe("boolean");
          break;
        case "number":
        case "duration":
          expect(typeof value).toBe("number");
          break;
        case "enum":
          expect(control.options?.some((option) => option.value === value)).toBe(true);
          break;
        case "text":
        case "path":
        case "multiline":
          expect(value === undefined || typeof value === "string").toBe(true);
          break;
        case "list":
          expect(Array.isArray(value)).toBe(true);
          break;
        case "secret":
        case "map":
        case "rows":
          throw new Error(`Unexpected non-scalar Tools control ${key}`);
      }
    }

    expect(TOOLS_SETTING_DEFAULTS["tools.speculativeExecution.enabled"]).toBe(false);
    expect(TOOLS_SETTING_DEFAULTS["tools.speculativeExecution.maxInFlight"]).toBe(2);
    expect(TOOLS_SETTING_DEFAULTS["async.enabled"]).toBe(true);
    expect(TOOLS_SETTING_DEFAULTS["async.maxJobs"]).toBe(100);
    expect(controls.find((control) => control.key === "async.enabled")?.apply).toBe("live");
    expect(TOOLS_APPROVAL_DEFAULTS).toEqual({ mode: "yolo", perTool: {} });
    expect(TOOLS_POLICY_CONFIG_KEYS).toContain("tools.approval");
    for (const key of TOOLS_POLICY_CONFIG_KEYS) expect(controlKeys).not.toContain(key);
  });

  test("projects every v18.6.1 default with provenance for all Tools keys", async () => {
    const policy = projectToolsPolicy(await readToolsSettings(fakeConfigStore().client, null));
    const keys = Object.keys(TOOLS_SETTING_DEFAULTS) as (keyof typeof TOOLS_SETTING_DEFAULTS)[];
    const sortedKeys = [...keys].sort();

    expect(Object.keys(policy.settings).sort()).toEqual(sortedKeys);
    expect(Object.keys(policy.provenance).sort()).toEqual(sortedKeys);
    for (const key of keys) {
      expect(policy.settings[key]).toEqual(TOOLS_SETTING_DEFAULTS[key]);
      expect(policy.provenance[key]).toEqual({
        source: "default",
        overrides: [],
        provenance: { origin: "host-fallback", ompVersion: "18.6.1" },
      });
    }
  });

  test("reads effective entries once, projects provenance, and keeps record and secret policy typed", async () => {
    const projectFolder = FolderPath.parse("/repo/project");
    const { state, client } = fakeConfigStore([
      configValue("glob.enabled", false, "project", ["global"]),
      configValue("async.maxJobs", 22, "runtime"),
      configValue("tools.approval", { bash: "deny", read: "allow" }, "project", ["global"]),
      configValue("tools.approvalMode", "write", "global"),
      configSecret("dev.autoqaPush.token", true, "global"),
      configValue("dev.autoqaConsent", "granted", "project"),
      configValue("grep.contextBefore", 2),
      configValue("browser.headless", false),
      configValue("computer.maxWidth", 1920),
      configValue("github.cache.enabled", false),
      configValue("tools.artifactMaxBytes", 32),
      configValue("tools.speculativeExecution.enabled", true),
      configValue("tools.speculativeExecution.maxInFlight", 3),
      configValue("extensionHandlers.toolCallTimeoutMs", 45_000),
      configValue("dev.autoqa", false),
      configValue("ida.maxOpen", 8),
      configValue("todo.reminders", false),
      configValue("todo.remindersMax", 4),
      configValue("tasks.todoClearDelay", -1),
      configValue("async.maxPollTimeMs", 5_000),
      configValue("irc.timeoutMs", 30_000),
    ]);

    const config = await readToolsSettings(client, projectFolder);
    const policy = projectToolsPolicy(config);

    expect(state.listFolders).toEqual([projectFolder]);
    expect(config.revision).toBe("revision-1");
    expect(Object.keys(config.sections)).toHaveLength(10);
    expect(config.sections["S3.toolsAvailable"].entries.map((entry) => entry.key)).toContain(
      "glob.enabled",
    );
    expect(config.entries.map((entry) => entry.key)).not.toContain("async.maxPollTimeMs");
    expect(config.entries.map((entry) => entry.key)).not.toContain("irc.timeoutMs");
    expect(policy.availability.glob).toBe(false);
    expect(policy.execution.asyncMaxJobs).toBe(22);
    expect(policy.provenance["glob.enabled"]).toMatchObject({
      source: "project",
      overrides: ["global"],
    });
    expect(policy.provenance["async.maxJobs"].source).toBe("runtime");
    expect(policy.grepBrowser).toMatchObject({ contextBefore: 2, headless: false });
    expect(policy.computer.maxWidth).toBe(1920);
    expect(policy.github.cacheEnabled).toBe(false);
    expect(policy.outputLimits.artifactMaxBytes).toBe(32);
    expect(policy.execution).toMatchObject({
      speculativeExecutionEnabled: true,
      speculativeExecutionMaxInFlight: 3,
      asyncMaxJobs: 22,
    });
    expect(policy.extensions.toolCallTimeoutMs).toBe(45_000);
    expect(policy.developer.autoqa).toBe(false);
    expect(policy.ida.maxOpen).toBe(8);
    expect(policy.todos).toMatchObject({
      reminders: false,
      remindersMax: 4,
      todoClearDelay: -1,
    });
    expect(policy.approval).toMatchObject({
      mode: "write",
      perTool: { bash: "deny", read: "allow" },
    });
    expect(policy.approval.provenance.mode.source).toBe("global");
    expect(policy.approval.provenance.perTool).toMatchObject({
      source: "project",
      overrides: ["global"],
    });
    expect(policy.developer.autoqaPushToken).toMatchObject({
      isSet: true,
      provenance: { source: "global" },
    });
    expect(policy.developer.autoqaConsent).toBe("granted");
    expect(policy.developer.autoqaConsentProvenance.source).toBe("project");
    expect(policy.redacted).toContain("dev.autoqaPush.token");
    expect(
      "value" in (config.entries.find((entry) => entry.key === "dev.autoqaPush.token") ?? {}),
    ).toBe(false);
  });

  test("falls back on invalid bounds, URLs, and record policy values", async () => {
    const { client } = fakeConfigStore([
      configValue("async.maxJobs", -1),
      configValue("browser.cdpUrl", "not-a-url"),
      configValue("dev.autoqaPush.endpoint", "not-a-url"),
      configValue("tools.approval", { bash: "sometimes" }),
      configValue("tools.approvalMode", "automatic"),
    ]);
    const policy = projectToolsPolicy(await readToolsSettings(client, null));

    expect(policy.execution.asyncMaxJobs).toBe(100);
    expect(policy.grepBrowser.cdpUrl).toBeUndefined();
    expect(policy.developer.autoqaPushEndpoint).toBe(
      TOOLS_SETTING_DEFAULTS["dev.autoqaPush.endpoint"],
    );
    expect(policy.approval).toMatchObject({ mode: "yolo", perTool: {} });
    expect(policy.invalid).toEqual(
      expect.arrayContaining([
        "async.maxJobs",
        "browser.cdpUrl",
        "dev.autoqaPush.endpoint",
        "tools.approval",
        "tools.approvalMode",
      ]),
    );
    expect(policy.developer.autoqaPushToken).toMatchObject({
      isSet: false,
      provenance: { source: "default", overrides: [] },
    });
    expect(policy.developer.autoqaConsent).toBe("unset");
    expect(policy.developer.autoqaConsentProvenance.source).toBe("default");
  });

  test("writes staged keys with sequential revision CAS and applies the strongest boundary", async () => {
    const { state, client } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, { folder: null, layer: "global" });
    await store.read();

    expect(store.stage("async.enabled", { secret: false, value: false }).ok).toBe(true);
    expect(store.stage("async.maxJobs", { secret: false, value: 12 }).ok).toBe(true);
    const result = await store.save();

    expect(state.writes.map((write) => [write.key, write.expectedRevision])).toEqual([
      ["async.enabled", "revision-1"],
      ["async.maxJobs", "revision-2"],
    ]);
    expect(result.revision).toBe("revision-3");
    expect(result.status).toBe("reload-required");
    expect(result.snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "async.enabled", value: false }),
        expect.objectContaining({ key: "async.maxJobs", value: 12 }),
      ]),
    );
    expect(store.getSnapshot().policy?.execution).toMatchObject({
      asyncEnabled: false,
      asyncMaxJobs: 12,
    });
  });

  test("reloads remote policy on CAS conflict and requires explicit resolution", async () => {
    const { state, client } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, { folder: null, layer: "global" });
    await store.read();
    expect(store.stage("async.maxJobs", { secret: false, value: 7 }).ok).toBe(true);

    state.revision = "revision-2";
    state.revisionIndex = 2;
    state.entries.push(configValue("async.maxJobs", 88, "global"));
    await expect(store.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(store.getSnapshot()).toMatchObject({
      phase: "conflict",
      config: { revision: "revision-2" },
      staged: { snapshot: { revision: "revision-2" }, edits: { "async.maxJobs": { value: 7 } } },
    });
    expect(store.getSnapshot().policy?.execution.asyncMaxJobs).toBe(88);
    expect(state.writes).toHaveLength(1);
    await store.resolveConflict("keep-mine");
    expect(store.getSnapshot().phase).toBe("editing");
    await store.save();

    expect(state.writes.map((write) => write.expectedRevision)).toEqual([
      "revision-1",
      "revision-2",
    ]);
    expect(state.entries.find((entry) => entry.key === "async.maxJobs")).toMatchObject({
      value: 7,
    });
    expect(store.getSnapshot().phase).toBe("ready");
  });

  test("exposes rejected edits as validation and does not stage them", async () => {
    const { client } = fakeConfigStore();
    const snapshot: ToolsConfigSnapshot = await readToolsSettings(client, null);
    const staged = { snapshot, edits: {} };
    const result = stageToolsSetting(staged, "async.maxJobs", { secret: false, value: -1 });

    expect(result).toMatchObject({ ok: false, validation: { valid: false } });
    expect(staged.edits).toEqual({});
  });
});
