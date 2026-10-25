import {
  AppFailure,
  ConfigChanged,
  type ConfigEntry,
  type ConfigSource,
  type ConfigWriteResult,
  FolderPath,
  JsonValue,
  OMP_FLOOR_VERSION,
  type SettingSource,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
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
  listeners: Set<(change: ConfigChanged) => void>;
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
  readonly source: ConfigChangeSource;
} {
  const state: FakeConfigStore = {
    revision: "revision-1",
    revisionIndex: 1,
    entries: [...entries],
    listFolders: [],
    writes: [],
    listeners: new Set(),
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
      const folder = args.folder === null ? null : FolderPath.parse(args.folder);
      return {
        key: args.key,
        layer: args.layer,
        folder,
        revision: state.revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
  const source: ConfigChangeSource = {
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  return { state, client, source };
}

function emitChange(
  state: FakeConfigStore,
  key: string,
  revision: string,
  entry: ConfigEntry,
  folder: FolderPath | null = null,
): void {
  const change = ConfigChanged.parse({
    key,
    layer: entry.source,
    folder,
    revision,
    entry,
  });
  for (const listener of state.listeners) listener(change);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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
    // omp v18.12.6 packages/coding-agent/src/tools/settings.ts:675-701 (default "takeover") and :948-959 (default true).
    expect(TOOLS_SETTING_DEFAULTS["computer.backgroundFallback"]).toBe("takeover");
    expect(TOOLS_SETTING_DEFAULTS["async.widgets"]).toBe(true);
    expect(controls.find((control) => control.key === "async.enabled")?.apply).toBe("live");
    expect(TOOLS_APPROVAL_DEFAULTS).toEqual({ mode: "yolo", perTool: {} });
    expect(TOOLS_POLICY_CONFIG_KEYS).toContain("tools.approval");
    for (const key of TOOLS_POLICY_CONFIG_KEYS) expect(controlKeys).not.toContain(key);
  });

  test("projects every default with provenance for all Tools keys", async () => {
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
        provenance: { origin: "host-fallback", ompVersion: OMP_FLOOR_VERSION },
      });
    }
  });
  test("projects normalized values used by omp for numeric policy settings", async () => {
    const { client } = fakeConfigStore([
      configValue("async.maxJobs", 250),
      configValue("extensionHandlers.toolCallTimeoutMs", 0),
      configValue("ida.maxOpen", 0),
    ]);
    const policy = projectToolsPolicy(await readToolsSettings(client, null));

    expect(policy.execution.asyncMaxJobs).toBe(100);
    expect(policy.extensions.toolCallTimeoutMs).toBe(30_000);
    expect(policy.ida.maxOpen).toBe(1);
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
      configValue("tools.artifactSpillThreshold", 64),
      configValue("tools.artifactTailBytes", 20),
      configValue("tools.artifactHeadBytes", 10),
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
    expect(policy.outputLimits).toMatchObject({
      artifactSpillThresholdKb: 64,
      artifactTailKb: 20,
      artifactHeadKb: 10,
      artifactMaxMb: 32,
    });
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

  test("preserves omp-effective values, maps legacy find booleans, and clamps async capacity", async () => {
    const { client } = fakeConfigStore([
      configValue("grep.contextBefore", 150),
      configValue("find.enabled", true),
      configValue("async.maxJobs", 150),
    ]);
    const policy = projectToolsPolicy(await readToolsSettings(client, null));

    expect(policy.settings["grep.contextBefore"]).toBe(150);
    expect(policy.settings["find.enabled"]).toBe("on");
    expect(policy.availability.find).toBe("on");
    expect(policy.execution.asyncMaxJobs).toBe(100);
    expect(policy.invalid).not.toEqual(
      expect.arrayContaining(["grep.contextBefore", "find.enabled", "async.maxJobs"]),
    );
  });

  test.each(["always-ask", "always-ask-cached", "write", "yolo"] as const)(
    "projects the saved approval mode %s as omp saves it",
    async (mode) => {
      const { client } = fakeConfigStore([configValue("tools.approvalMode", mode)]);
      const policy = projectToolsPolicy(await readToolsSettings(client, null));

      expect(policy.approval.mode).toBe(mode);
      expect(policy.invalid).not.toContain("tools.approvalMode");
    },
  );

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
    const { state, client, source } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });
    await store.read();

    expect(store.stage("async.enabled", { secret: false, value: false }).ok).toBe(true);
    expect(store.stage("async.maxJobs", { secret: false, value: 12 }).ok).toBe(true);
    const result = await store.save();

    expect(state.writes.map((write) => [write.key, write.expectedRevision])).toEqual([
      ["async.enabled", "revision-1"],
      ["async.maxJobs", "revision-2"],
    ]);
    expect(result.revision).toBe("revision-3");
    expect(result.status).toBe("applied");
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
    store.dispose();
  });

  test("coalesces concurrent saves into one CAS operation", async () => {
    const { state, client, source } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });
    await store.read();
    expect(store.stage("async.maxJobs", { secret: false, value: 12 }).ok).toBe(true);

    const first = store.save();
    const second = store.save();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ key: "async.maxJobs", expectedRevision: "revision-1" });
    expect(store.getSnapshot().phase).toBe("ready");
    store.dispose();
  });
  test("rejects new edits while a save is in flight instead of dropping them", async () => {
    const { state, client, source } = fakeConfigStore();
    let releaseWrite = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const delayedClient: ConfigStoreClient = {
      read: (args) => client.read(args),
      list: (args) => client.list(args),
      write: async (args) => {
        await writeGate;
        return client.write(args);
      },
    };
    const store = new ToolsSettingsStore(delayedClient, source, { folder: null, layer: "global" });
    await store.read();
    expect(store.stage("async.maxJobs", { secret: false, value: 12 }).ok).toBe(true);

    const saving = store.save();
    expect(store.getSnapshot().phase).toBe("saving");
    const stagedDuringSave = store.stage("async.enabled", { secret: false, value: false });
    expect(stagedDuringSave).toMatchObject({
      ok: false,
      validation: {
        valid: false,
        code: "not-ready",
        message: "Settings are saving. Try again in a moment.",
      },
    });
    expect(store.getSnapshot().phase).toBe("saving");
    releaseWrite();
    await saving;

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.key).toBe("async.maxJobs");
    expect(store.getSnapshot().staged?.edits).toEqual({});
    store.dispose();
  });

  test("reloads remote policy on CAS conflict and requires explicit resolution", async () => {
    const { state, client, source } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });
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
    store.dispose();
  });

  test("refreshes external policy changes, conflicts with staged edits, and unsubscribes on dispose", async () => {
    const { state, client, source } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });
    await store.read();

    const firstEntry = configValue("glob.enabled", false);
    state.revision = "revision-2";
    state.revisionIndex = 2;
    state.entries.push(firstEntry);
    emitChange(state, "glob", state.revision, configValue("glob", { enabled: false }));
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      phase: "ready",
      config: { revision: "revision-2" },
      policy: { availability: { glob: false } },
    });

    expect(store.stage("async.enabled", { secret: false, value: false }).ok).toBe(true);
    const secondEntry = configValue("glob.enabled", true);
    state.revision = "revision-3";
    state.revisionIndex = 3;
    const globIndex = state.entries.findIndex((entry) => entry.key === "glob.enabled");
    state.entries[globIndex] = secondEntry;
    emitChange(state, "glob", state.revision, configValue("glob", { enabled: true }));
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      phase: "conflict",
      config: { revision: "revision-3" },
      staged: { edits: { "async.enabled": { value: false } } },
      policy: { availability: { glob: true } },
    });
    await store.resolveConflict("reload");
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", staged: { edits: {} } });

    store.dispose();
    expect(state.listeners.size).toBe(0);
    const beforeDisposeChange = store.getSnapshot();
    state.revision = "revision-4";
    emitChange(state, "glob", state.revision, configValue("glob", { enabled: false }));
    await settle();
    expect(store.getSnapshot()).toBe(beforeDisposeChange);
  });

  test("staging after an outside change keeps the conflict, so the save is refused and nothing is written", async () => {
    const { state, client, source } = fakeConfigStore();
    const store = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });
    await store.read();

    expect(store.stage("async.enabled", { secret: false, value: false }).ok).toBe(true);
    // The same setting changes outside while the person's edit is staged: a conflict.
    state.revision = "revision-2";
    state.revisionIndex = 2;
    state.entries.push(configValue("async.enabled", true));
    emitChange(state, "async", state.revision, configValue("async.enabled", true));
    await settle();
    expect(store.getSnapshot()).toMatchObject({ phase: "conflict" });

    // Staging another value must not clear the conflict, or the save would overwrite the outside value unseen.
    expect(store.stage("async.enabled", { secret: false, value: true }).ok).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ phase: "conflict" });
    await expect(store.save()).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "Resolve the Tools settings conflict before saving.",
      },
    });
    expect(state.writes).toHaveLength(0);
    store.dispose();
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
