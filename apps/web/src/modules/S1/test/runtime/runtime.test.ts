import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  type FolderPath,
} from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSettingsRuntime, type SettingsRuntime } from "../../runtime";
import { SETTINGS_READ_TIMEOUT_MS, type SettingsSectionDescriptor } from "../../settings-kit";

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
  nextListFailure: AppFailure | null;
  /** The next list never answers, so a read has to end in the timeout. */
  hangNextList: boolean;
  /** Keys omp refuses once: that write fails and nothing is written. */
  refusedKeys: Set<string>;
  /** omp rewrites the file (no value changes) right after the next list: an outside rewrite between a conflict's read and its retry. */
  revisionAfterNextList: string | null;
  /** omp rewrites the file right after the next successful write: an outside rewrite between two keys of one save. */
  revisionAfterNextWrite: string | null;
};

function fakeState(): FakeState {
  return {
    revision: "revision-1",
    entries: initialEntries.map((entry) => ({ ...entry })),
    writes: [],
    scopes: [],
    listeners: new Set(),
    nextListFailure: null,
    hangNextList: false,
    refusedKeys: new Set(),
    revisionAfterNextList: null,
    revisionAfterNextWrite: null,
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
      if (state.hangNextList) {
        state.hangNextList = false;
        return Promise.withResolvers<never>().promise;
      }
      if (state.nextListFailure) {
        const failure = state.nextListFailure;
        state.nextListFailure = null;
        throw failure;
      }
      const listing = { entries: [...state.entries], revision: state.revision };
      if (state.revisionAfterNextList) {
        state.revision = state.revisionAfterNextList;
        state.revisionAfterNextList = null;
      }
      return listing;
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
      if (state.revisionAfterNextWrite) {
        state.revision = state.revisionAfterNextWrite;
        state.revisionAfterNextWrite = null;
      }
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
    // Someone else set the same setting, so the value omp holds now differs from the one read.
    state.entries[0] = {
      key: "appearance.mode",
      secret: false,
      value: "light",
      source: "global",
      overrides: [],
    };
    state.revision = "revision-external";
    emit(
      state,
      change(
        "appearance.mode",
        "revision-external",
        {
          key: "appearance.mode",
          secret: false,
          value: "light",
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
    // Someone else changed the same setting, so omp refuses the write and the value it holds differs.
    state.entries[0] = {
      key: "appearance.mode",
      secret: false,
      value: "light",
      source: "global",
      overrides: [],
    };
    state.revision = "revision-changed";
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

  test("an outside rewrite that leaves the edited settings alone is not a conflict", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    // omp rewrote the file with the same effective values: the revision moves and no event is sent.
    state.revision = "revision-rewritten";
    await runtime.save();
    expect(state.writes.at(-1)).toMatchObject({
      key: "appearance.mode",
      expectedRevision: "revision-rewritten",
    });
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.getSnapshot().conflict).toBeNull();
  });

  test("an outside change to another setting is not a conflict for this section's edits", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    state.revision = "revision-other";
    emit(
      state,
      change("terminal.showImages", "revision-other", {
        key: "terminal.showImages",
        secret: false,
        value: true,
        source: "global",
        overrides: [],
      }),
    );
    await settle();
    expect(runtime.getSnapshot().phase).toBe("editing");
    expect(runtime.getSnapshot().conflict).toBeNull();
    expect(runtime.getSnapshot().staged?.edits).toEqual({
      "appearance.mode": { secret: false, value: "dark" },
    });
    await runtime.save();
    expect(state.writes.at(-1)).toMatchObject({
      key: "appearance.mode",
      expectedRevision: "revision-other",
    });
  });

  test("a second outside rewrite during the retried save keeps the edits and says why they were not written", async () => {
    const state = fakeState();
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    // omp rewrote the file without changing the theme, and rewrites it again between the conflict's
    // read and the retry: the retry conflicts too.
    state.revision = "revision-rewritten";
    state.revisionAfterNextList = "revision-rewritten-again";
    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.phase).toBe("editing");
    expect(snapshot.conflict).toBeNull();
    expect(snapshot.error?.code).toBe("conflict");
    expect(snapshot.error?.message).toContain("changed elsewhere");
    expect(snapshot.unsavedKeys).toEqual(["appearance.mode"]);
    expect(snapshot.staged?.edits).toEqual({ "appearance.mode": { secret: false, value: "dark" } });
    // Once omp stops rewriting, the next save writes the kept edit.
    await runtime.save();
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(state.entries.find((entry) => entry.key === "appearance.mode")).toMatchObject({
      value: "dark",
    });
  });

  test("a restart the first write needed is still reported when a carried retry writes the rest", async () => {
    const state = fakeState();
    // The restart key is written first; the theme follows and meets an outside rewrite that changes no edit.
    const restartFirst: SettingsSectionDescriptor = {
      ...descriptor,
      controls: [...descriptor.controls].reverse(),
    };
    const runtime = createSettingsRuntime(fakeClient(state), {
      descriptor: restartFirst,
      folder: null,
      layer: "global",
    });
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("provider.apiKey", { secret: true, action: "set", value: "new-key" });
    runtime.stage("appearance.mode", { secret: false, value: "dark" });
    state.revisionAfterNextWrite = "revision-rewritten";
    await runtime.save();
    expect(state.writes.map((write) => write.key)).toEqual([
      "provider.apiKey",
      "appearance.mode",
      "appearance.mode",
    ]);
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.getSnapshot().applyStatus).toBe("restart-required");
  });

  test("a read the server never answers ends in a timeout the section can retry", async () => {
    vi.useFakeTimers();
    try {
      const state = fakeState();
      state.hangNextList = true;
      const runtime = createSettingsRuntime(fakeClient(state), {
        descriptor,
        folder: null,
        layer: "global",
      });
      runtimes.push(runtime);
      const outcome = runtime.read().then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS);
      expect(runtime.getSnapshot().phase).toBe("error");
      expect(await outcome).toMatchObject({
        appError: { code: "timeout", message: "Settings took too long to load.", retryable: true },
      });

      await runtime.retry();
      expect(runtime.getSnapshot().phase).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});
