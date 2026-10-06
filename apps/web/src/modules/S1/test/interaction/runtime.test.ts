import {
  AppFailure,
  type ConfigEntry,
  ConfigWriteArgs,
  type ConfigWriteResult,
} from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import { APPROVALS_SECTION, INPUT_SETTINGS_SECTION } from "../../interaction";

const STARTING_ENTRY: ConfigEntry = {
  key: "steeringMode",
  secret: false,
  value: "one-at-a-time",
  source: "default",
  overrides: [],
};

const STARTING_APPROVAL_ENTRY: ConfigEntry = {
  key: "tools.approval",
  secret: false,
  value: {},
  source: "default",
  overrides: [],
};

const STARTING_APPROVAL_MODE_ENTRY: ConfigEntry = {
  key: "tools.approvalMode",
  secret: false,
  value: "yolo",
  source: "default",
  overrides: [],
};

type FakeConfig = {
  entries: ConfigEntry[];
  revision: string;
  writes: ConfigWriteArgs[];
  conflictNextWrite: boolean;
  listFolders: (string | null)[];
};

function fakeConfig(): FakeConfig {
  return {
    entries: [STARTING_ENTRY, STARTING_APPROVAL_ENTRY, STARTING_APPROVAL_MODE_ENTRY],
    revision: "revision-1",
    writes: [],
    conflictNextWrite: false,
    listFolders: [],
  };
}

function fakeClient(state: FakeConfig): ConfigStoreClient {
  return {
    async read({ key }) {
      const found = state.entries.find((entry) => entry.key === key);
      if (!found)
        throw new AppFailure({
          code: "not_found",
          message: "Configuration key was not found.",
          retryable: false,
        });
      return found;
    },
    async list({ folder }) {
      state.listFolders.push(folder ?? null);
      return { entries: state.entries, revision: state.revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgs.parse(input);
      state.writes.push(args);
      if (state.conflictNextWrite) {
        state.conflictNextWrite = false;
        state.revision = "revision-external";
        state.entries = state.entries.map((entry) =>
          entry.key === args.key
            ? {
                ...entry,
                value: "immediate",
                source: "project" as const,
                overrides: ["global", "default"] as ConfigEntry["overrides"],
              }
            : entry,
        );
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
      if (args.value.secret)
        throw new Error("The input settings fixture does not support secret writes.");

      const previousRevision = state.revision;
      state.revision = "revision-2";
      const entry: ConfigEntry = {
        key: args.key,
        secret: false,
        value: args.value.value,
        source: args.layer,
        overrides: ["default"],
      };
      state.entries = state.entries.map((candidate) =>
        candidate.key === args.key ? entry : candidate,
      );
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

const changeSource: ConfigChangeSource = {
  subscribe: () => () => {},
};

const runtimes: SettingsRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function runtimeFor(
  state: FakeConfig,
  descriptor: SettingsSectionDescriptor = INPUT_SETTINGS_SECTION,
): SettingsRuntime {
  const runtime = new SettingsRuntime(fakeClient(state), changeSource, {
    descriptor,
    folder: null,
    layer: "global",
  });
  runtimes.push(runtime);
  return runtime;
}

describe("S1.4 interaction ConfigStore consumers", () => {
  test("reads the typed section through ConfigStore and keeps its effective source", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state);
    const snapshot: ConfigSnapshot = await runtime.read();

    expect(state.listFolders).toEqual([null]);
    expect(snapshot.entries).toEqual([STARTING_ENTRY]);
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(snapshot.entries[0]).toMatchObject({
      key: "steeringMode",
      value: "one-at-a-time",
      source: "default",
    });
  });

  test("writes one staged interaction value with a revision-checked CAS", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state);
    await runtime.read();

    const staged = runtime.stage("steeringMode", { secret: false, value: "all" });
    expect(staged.ok).toBe(true);
    await runtime.save();

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      key: "steeringMode",
      layer: "global",
      folder: null,
      expectedRevision: "revision-1",
      value: { secret: false, value: "all" },
    });
    expect(runtime.getSnapshot().config?.revision).toBe("revision-2");
    expect(runtime.getSnapshot().staged?.edits).toEqual({});
  });

  test("writes per-tool approval policies through a one-key revision-checked CAS", async () => {
    const state = fakeConfig();
    const runtime = runtimeFor(state, APPROVALS_SECTION);
    await runtime.read();

    runtime.stage("tools.approval", {
      secret: false,
      value: { bash: "deny", task: "prompt" },
    });
    await runtime.save();

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      key: "tools.approval",
      layer: "global",
      folder: null,
      expectedRevision: "revision-1",
      value: { secret: false, value: { bash: "deny", task: "prompt" } },
    });
  });

  test("preserves local edits and reloads the remote section after a stale CAS conflict", async () => {
    const state = fakeConfig();
    state.conflictNextWrite = true;
    const runtime = runtimeFor(state);
    await runtime.read();
    runtime.stage("steeringMode", { secret: false, value: "all" });

    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(runtime.getSnapshot().phase).toBe("conflict");
    expect(runtime.getSnapshot().conflict?.changedKeys).toEqual(["steeringMode"]);
    expect(runtime.getSnapshot().conflict?.remote.entries[0]).toMatchObject({
      value: "immediate",
      source: "project",
      overrides: ["global", "default"],
    });
    expect(runtime.getSnapshot().conflict?.local.edits).toEqual({
      steeringMode: { secret: false, value: "all" },
    });
    expect(state.writes[0]?.expectedRevision).toBe("revision-1");
  });
});
