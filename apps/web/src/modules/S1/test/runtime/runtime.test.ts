import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  type FolderPath,
} from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { createSettingsRuntime, type SettingsRuntime } from "../../runtime";
import type { SettingsSectionDescriptor } from "../../settings-kit";

const descriptor: SettingsSectionDescriptor = {
  id: "S1.runtimeTest",
  section: "appearance/Theme",
  title: "Runtime settings",
  inventory: [],
  requires: [],
  controls: [
    {
      key: "appearance.mode",
      label: "Theme",
      kind: "enum",
      secret: false,
      options: [
        { value: "system", label: "System" },
        { value: "dark", label: "Dark" },
      ],
      validate: (value) =>
        value.secret || value.value === "system" || value.value === "dark"
          ? { valid: true }
          : { valid: false, code: "enum", message: "Choose a supported theme." },
      apply: "reload",
    },
    {
      key: "provider.apiKey",
      label: "API key",
      kind: "secret",
      secret: true,
      validate: () => ({ valid: true }),
      apply: "restart",
    },
  ],
};

const initialEntries: readonly ConfigEntry[] = [
  { key: "appearance.mode", secret: false, value: "system", source: "global", overrides: [] },
  { key: "provider.apiKey", secret: true, isSet: true, source: "global", overrides: [] },
];

type FakeState = {
  revision: string;
  entries: ConfigEntry[];
  writes: ConfigWriteArgs[];
  scopes: string[];
  listeners: Set<(change: ConfigChanged) => void>;
  nextWriteFailure: AppFailure | null;
  nextListFailure: AppFailure | null;
  /** Keys omp refuses once: that write fails and nothing is written. */
  refusedKeys: Set<string>;
};

function fakeState(): FakeState {
  return {
    revision: "revision-1",
    entries: initialEntries.map((entry) => ({ ...entry })),
    writes: [],
    scopes: [],
    listeners: new Set(),
    nextWriteFailure: null,
    nextListFailure: null,
    refusedKeys: new Set(),
  };
}

function fakeClient(state: FakeState): AppClient {
  const port = {
    read: async (args: { readonly key: string; readonly folder: string | null }) => {
      const entry = state.entries.find((item) => item.key === args.key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async (_args: { readonly folder: string | null }) => {
      if (state.nextListFailure) {
        const failure = state.nextListFailure;
        state.nextListFailure = null;
        throw failure;
      }
      return {
        entries: [...state.entries],
        revision: state.revision,
      };
    },
    write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
      state.writes.push(args);
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Cannot write configuration: the file changed.",
          retryable: true,
        });
      }
      if (state.nextWriteFailure) {
        const failure = state.nextWriteFailure;
        state.nextWriteFailure = null;
        throw failure;
      }
      if (state.refusedKeys.delete(args.key)) {
        throw new AppFailure({
          code: "invalid_args",
          message: "This setting could not be written to the settings file.",
          retryable: false,
        });
      }
      const revision = `revision-${state.writes.length + 1}`;
      state.revision = revision;
      const index = state.entries.findIndex((entry) => entry.key === args.key);
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
            value: args.value.value,
            source: args.layer,
            overrides: [],
          };
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
  return {
    port: () => port,
    subscribe: async (_port: unknown, _event: unknown, options: { readonly scope?: string }) => {
      const scope = options.scope ?? "missing-scope";
      state.scopes.push(scope);
      return {
        stream: `A1.configStore.changed:${scope}`,
        lastSeq: 0,
        onEvent: (listener: (payload: ConfigChanged, seq: number) => void) => {
          const wrapped = (change: ConfigChanged) => listener(change, 1);
          state.listeners.add(wrapped);
          return () => state.listeners.delete(wrapped);
        },
        unsubscribe: async () => undefined,
      };
    },
  } as unknown as AppClient;
}

function emit(state: FakeState, change: ConfigChanged): void {
  for (const listener of state.listeners) listener(change);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function change(
  key: string,
  revision: string,
  entry: ConfigEntry,
  folder: FolderPath | null = null,
): ConfigChanged {
  return { key, layer: "global", folder, revision, entry };
}

const runtimes: SettingsRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe("S1.2 ConfigStore runtime", () => {
  test("reads through A0.8, binds the global activity scope, and keeps secrets redacted", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    expect(state.scopes).toEqual(["global"]);
    expect(runtime.getSnapshot().config?.entries).toEqual(initialEntries);
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain("secret-value");
  });

  test("stages and saves one-key CAS writes with the returned revision", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    const staged = runtime.stage("appearance.mode", { secret: false, value: "dark" });
    expect(staged.ok).toBe(true);
    const result = await runtime.save();
    expect(result.status).toBe("reload-required");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      key: "appearance.mode",
      layer: "global",
      expectedRevision: "revision-1",
      value: { secret: false, value: "dark" },
    });
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.getSnapshot().staged?.edits).toEqual({});
  });

  test("shows an external change as a conflict and supports keep-mine then retry", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: "/workspace/project" as FolderPath,
      layer: "project",
    });
    runtimes.push(runtime);
    await runtime.read();
    expect(state.scopes).toEqual(["/workspace/project"]);
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    state.revision = "revision-external";
    emit(
      state,
      change(
        "appearance.mode",
        "revision-external",
        {
          key: "appearance.mode",
          secret: false,
          value: "system",
          source: "global",
          overrides: [],
        },
        "/workspace/project" as FolderPath,
      ),
    );
    await settle();
    expect(runtime.getSnapshot().phase).toBe("conflict");
    expect(runtime.getSnapshot().conflict?.changedKeys).toEqual(["appearance.mode"]);
    runtime.resolveConflict("keep-mine");
    expect(runtime.getSnapshot().staged?.edits).toEqual({
      "appearance.mode": { secret: false, value: "dark" },
    });
    await runtime.save();
    expect(state.writes[0]?.expectedRevision).toBe("revision-external");
    expect(runtime.getSnapshot().phase).toBe("ready");
  });

  test("reload conflict choice discards local edits and surfaces AppFailure errors", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    state.nextWriteFailure = new AppFailure({
      code: "conflict",
      message: "changed elsewhere",
      retryable: true,
    });
    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(runtime.getSnapshot().phase).toBe("conflict");
    runtime.resolveConflict("reload");
    expect(runtime.getSnapshot().staged?.edits).toEqual({});

    const brokenState = fakeState();
    const brokenRuntime = createSettingsRuntime(fakeClient(brokenState), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(brokenRuntime);
    brokenState.nextListFailure = new AppFailure({
      code: "permission",
      message: "blocked",
      retryable: false,
    });
    await expect(brokenRuntime.read()).rejects.toMatchObject({ appError: { code: "permission" } });
    expect(brokenRuntime.getSnapshot().phase).toBe("error");
  });

  test("a save refused on one key reloads what omp holds, so the next save is not a false conflict", async () => {
    const state = fakeState();
    state.refusedKeys.add("provider.apiKey");
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    runtime.stage("provider.apiKey", { secret: true, action: "set", value: "fresh-value" });

    await expect(runtime.save()).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "This setting could not be written to the settings file.",
      },
    });
    const refused = runtime.getSnapshot();
    expect(refused.phase).toBe("editing");
    expect(refused.unsavedKeys).toEqual(["provider.apiKey"]);
    expect(refused.config?.revision).toBe("revision-2");
    expect(refused.staged?.edits).toEqual({
      "provider.apiKey": { secret: true, action: "set", value: "fresh-value" },
    });

    await runtime.save();
    expect(state.writes.at(-1)).toMatchObject({
      key: "provider.apiKey",
      expectedRevision: "revision-2",
    });
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.getSnapshot().unsavedKeys).toEqual([]);
  });
});
