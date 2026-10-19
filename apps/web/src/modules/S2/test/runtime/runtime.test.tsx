import type {
  ConfigChanged,
  ConfigEntry,
  ConfigWriteArgs,
  ConfigWriteLayer,
  ConfigWriteResult,
  ConfigWriteValue,
  FolderPath,
  JsonValue,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import {
  type ConfigChangeSource,
  type ConfigStoreClient,
  environmentOverrideText,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  type SettingControl,
  type SettingsSectionDescriptor,
  secretSummary,
} from "../../../S1/settings-kit";
import { FilesLspSection } from "../../lsp";
import { FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION } from "../../sections";
import { ShellBashSection, ShellEvalRuntimesSection } from "../../shell";

const GROUPS = [FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION] as const;

type DefaultFixture = {
  readonly key: string;
  readonly value: JsonValue;
  readonly source: "default" | "runtime";
  readonly kind?: SettingControl["kind"];
  readonly citation: string;
};

// omp v18.9.1 declarations pin defaults/types; tagged consumer locations justify the runtime apply policy.
const DEFAULTS: readonly DefaultFixture[] = [
  {
    key: "lsp.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:8-18; tools/index.ts:740-742; sdk.ts:5088-5136",
  },
  {
    key: "lsp.lazy",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:20-31; sdk.ts:5077-5086,5130-5135; main.ts:2549-2555",
  },
  {
    key: "lsp.shared",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:33-44; sdk.ts:5064-5075",
  },
  {
    key: "lsp.formatOnWrite",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:46-56; write.ts:501-515",
  },
  {
    key: "lsp.diagnosticsOnWrite",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:58-68; write.ts:501-515",
  },
  {
    key: "lsp.diagnosticsOnEdit",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:70-80; edit/index.ts:172-177",
  },
  {
    key: "lsp.diagnosticsDeduplicate",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:82-92; write.ts:501-515; lsp/deferred-diagnostics.ts:42-45",
  },
  {
    key: "bash.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:82-92; tools/index.ts:740-742",
  },
  {
    key: "bash.allowCompoundCommands",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:94-105; tools/bash.ts:503-504",
  },
  {
    key: "bash.autoBackground.enabled",
    value: true,
    source: "runtime",
    kind: "boolean",
    citation: "exec/settings.ts:107-118; tools/bash.ts:599-600,1139-1147",
  },
  {
    key: "bash.gitGuard",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:120-131; tools/bash.ts:854,1526",
  },
  {
    key: "bash.patterns",
    value: [],
    source: "default",
    citation: "exec/settings.ts:133-144; tools/bash.ts:503-504",
  },
  {
    key: "bashInterceptor.enabled",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:147-157; tools/bash.ts:992-1002",
  },
  {
    key: "bash.direnv",
    value: "auto",
    source: "default",
    kind: "enum",
    citation: "exec/settings.ts:165-177; exec/bash-executor.ts:561-563; tools/bash.ts:1219",
  },
  {
    key: "bash.direnvLoadTimeoutMs",
    value: 30_000,
    source: "default",
    kind: "duration",
    citation: "exec/settings.ts:179-190; exec/bash-executor.ts:561; tools/bash.ts:1217",
  },
  {
    key: "shellMinimizer.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:193-203; exec/bash-executor.ts:542",
  },
  {
    key: "shellMinimizer.sourceOutlineLevel",
    value: "default",
    source: "default",
    kind: "enum",
    citation: "exec/settings.ts:229-240; exec/bash-executor.ts:314",
  },
  {
    key: "eval.py",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:8-19; tools/eval-backends.ts:3-14",
  },
  {
    key: "eval.js",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:21-32; tools/eval-backends.ts:3-14",
  },
  {
    key: "eval.autoProvision",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:34-45; tools/eval.ts:398-404; eval/js/executor.ts:139",
  },
  {
    key: "eval.tools.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:46-58; task/eval-tools.ts:14-81; session/agent-session.ts:7229",
  },
  {
    key: "eval.workpool.freshAgents",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:59-69; task/workpool.ts:135-143",
  },
  {
    key: "eval.autoBackground.enabled",
    value: false,
    source: "runtime",
    kind: "boolean",
    citation: "eval/settings.ts:71-82; tools/eval.ts:398-404,613-630",
  },
  {
    key: "python.kernelMode",
    value: "session",
    source: "default",
    kind: "enum",
    citation: "eval/settings.ts:92-103; eval/py/index.ts:21-35; eval/py/executor.ts:599-603",
  },
  {
    key: "python.interpreter",
    value: "",
    source: "default",
    kind: "path",
    citation: "eval/settings.ts:105-116; eval/py/index.ts:21-35",
  },
];

const expectedByKey: Readonly<Record<string, DefaultFixture>> = Object.fromEntries(
  DEFAULTS.map((item) => [item.key, item]),
);
const runtimes: SettingsRuntime[] = [];

type FakeStore = {
  revision: string;
  entries: ConfigEntry[];
  writes: ConfigWriteArgs[];
  listeners: Set<(change: ConfigChanged) => void>;
  listFailures: number;
  refusedWrites: Readonly<Record<string, true>>;
  environmentKeys: Readonly<Record<string, string>>;
};

function createFakeRuntime(
  descriptor: SettingsSectionDescriptor,
  entries: readonly ConfigEntry[] = descriptor.controls.map((control) => {
    const fixture = expectedByKey[control.key];
    if (!fixture) throw new Error(`Missing default fixture for ${control.key}`);
    return {
      key: control.key,
      secret: false,
      value: fixture.value,
      source: fixture.source,
      overrides: [],
    } satisfies ConfigEntry;
  }),
  scope: { readonly folder: FolderPath | null; readonly layer: ConfigWriteLayer } = {
    folder: null,
    layer: "global",
  },
  options: {
    readonly refusedWrites?: Readonly<Record<string, true>>;
    readonly environmentKeys?: Readonly<Record<string, string>>;
  } = {},
) {
  const state: FakeStore = {
    revision: "revision-1",
    entries: entries.map((entry) => ({ ...entry })),
    writes: [],
    listeners: new Set(),
    listFailures: 0,
    refusedWrites: options.refusedWrites ?? {},
    environmentKeys: options.environmentKeys ?? {},
  };
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async () => {
      if (state.listFailures > 0) {
        state.listFailures -= 1;
        throw new AppFailure({
          code: "unavailable",
          message: "The settings service is not reachable.",
          retryable: true,
        });
      }
      return { entries: [...state.entries], revision: state.revision };
    },
    write: async (args): Promise<ConfigWriteResult> => {
      const value = args.value as ConfigWriteValue;
      state.writes.push(args as unknown as ConfigWriteArgs);
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere",
          retryable: true,
        });
      }
      if (state.refusedWrites[args.key]) {
        throw new AppFailure({
          code: "permission",
          message: "The fake settings store refused this write.",
          retryable: false,
        });
      }
      const previousRevision = state.revision;
      const revision = `revision-${state.writes.length + 1}`;
      state.revision = revision;
      const environmentVariable = state.environmentKeys[args.key];
      const entry: ConfigEntry = value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: value.action === "set",
            source: environmentVariable === undefined ? args.layer : "env",
            overrides: [],
            ...(environmentVariable === undefined ? {} : { overriddenBy: environmentVariable }),
          }
        : {
            key: args.key,
            secret: false,
            value: value.value,
            source: environmentVariable === undefined ? args.layer : "env",
            overrides: [],
            ...(environmentVariable === undefined ? {} : { overriddenBy: environmentVariable }),
          };
      const index = state.entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder as FolderPath | null,
        revision,
        previousRevision,
        entry,
      };
    },
  };
  const changes: ConfigChangeSource = {
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  const runtime = new SettingsRuntime(client, changes, { descriptor, ...scope });
  runtimes.push(runtime);
  return { runtime, state };
}

function publishChange(state: FakeStore, entry: ConfigEntry, revision: string): void {
  state.revision = revision;
  const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
  if (index < 0) state.entries.push(entry);
  else state.entries[index] = entry;
  const change: ConfigChanged = { key: entry.key, layer: "global", folder: null, revision, entry };
  for (const listener of state.listeners) listener(change);
}

function settingControl(descriptor: SettingsSectionDescriptor, key: string): SettingControl {
  const control = descriptor.controls.find((candidate) => candidate.key === key);
  if (!control) throw new Error(`Missing setting control ${key}`);
  return control;
}

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe("S2.3 LSP and Shell ConfigStore settings", () => {
  test("every S2.3 control has a description and uses omp's live apply boundary", () => {
    const controls = GROUPS.flatMap((descriptor) => descriptor.controls);
    expect(controls).toHaveLength(25);
    expect(controls.every((control) => control.apply === "live")).toBe(true);
    expect(controls.every((control) => control.description?.trim().length)).toBe(true);
  });
  test("reads the pinned defaults, value types, effective sources, and revisions through ConfigStore", async () => {
    expect(
      GROUPS.flatMap((descriptor) => descriptor.controls.map((control) => control.key)).sort(),
    ).toEqual(DEFAULTS.map((item) => item.key).sort());
    for (const descriptor of GROUPS) {
      const { runtime } = createFakeRuntime(descriptor);
      const snapshot = await runtime.read();
      expect(snapshot.revision).toBe("revision-1");
      expect(snapshot.entries.map((entry) => entry.key).sort()).toEqual(
        descriptor.controls.map((control) => control.key).sort(),
      );
      for (const entry of snapshot.entries) {
        const fixture = expectedByKey[entry.key];
        if (!fixture) throw new Error(`Missing source citation for ${entry.key}`);
        const control = settingControl(descriptor, entry.key);
        if (entry.secret)
          throw new Error(`${entry.key}: ${fixture.citation} unexpectedly returned a secret.`);
        if (fixture.kind)
          expect(control.kind, `${entry.key}: ${fixture.citation}`).toBe(fixture.kind);
        expect(entry.value, `${entry.key}: ${fixture.citation}`).toEqual(fixture.value);
        expect(entry.source, `${entry.key}: ${fixture.citation}`).toBe(fixture.source);
        expect(entry.overrides, `${entry.key}: ${fixture.citation}`).toEqual([]);
        expect(Array.isArray(entry.value), `${entry.key}: ${fixture.citation}`).toBe(
          fixture.kind === undefined || fixture.kind === "list",
        );
        if (control.kind === "enum") {
          expect(
            control.options?.some((option) => option.value === entry.value),
            fixture.citation,
          ).toBe(true);
        }
      }
    }
  });

  test("preserves the selected layer and override provenance without recomputing it", async () => {
    const base = FILES_LSP_SECTION.controls.map((control) => {
      const fixture = expectedByKey[control.key];
      if (!fixture) throw new Error(`Missing default fixture for ${control.key}`);
      return {
        key: control.key,
        secret: false,
        value: fixture.value,
        source: fixture.source,
        overrides: [],
      } satisfies ConfigEntry;
    });
    const sourcedEntry: ConfigEntry = {
      key: "lsp.shared",
      secret: false,
      value: false,
      source: "project",
      overrides: ["global"],
    };
    const projectFolder = "/workspace/project" as FolderPath;
    const { runtime } = createFakeRuntime(
      FILES_LSP_SECTION,
      base.map((entry) => (entry.key === sourcedEntry.key ? sourcedEntry : entry)),
      { folder: projectFolder, layer: "project" },
    );
    const snapshot = await runtime.read();
    expect(snapshot.entries.find((entry) => entry.key === sourcedEntry.key)).toEqual(sourcedEntry);
  });

  test("saves changed keys as sequential one-key CAS writes", async () => {
    const { runtime, state } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    expect(runtime.stage("lsp.shared", { secret: false, value: false }).ok).toBe(true);
    expect(runtime.stage("lsp.formatOnWrite", { secret: false, value: true }).ok).toBe(true);
    const result = await runtime.save();
    expect(result.status).toBe("applied");
    expect(state.writes).toHaveLength(2);
    expect(
      state.writes.map(({ key, layer, folder, expectedRevision, value }) => ({
        key,
        layer,
        folder,
        expectedRevision,
        value,
      })),
    ).toEqual([
      {
        key: "lsp.shared",
        layer: "global",
        folder: null,
        expectedRevision: "revision-1",
        value: { secret: false, value: false },
      },
      {
        key: "lsp.formatOnWrite",
        layer: "global",
        folder: null,
        expectedRevision: "revision-2",
        value: { secret: false, value: true },
      },
    ]);
    expect(runtime.getSnapshot().config?.revision).toBe("revision-3");
  });

  test("keeps invalid duration and interpreter values local without writing", async () => {
    const bash = createFakeRuntime(SHELL_BASH_SECTION);
    await bash.runtime.read();
    expect(
      bash.runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 600_001 }).ok,
    ).toBe(false);
    expect(bash.state.writes).toHaveLength(0);

    const runtimes = createFakeRuntime(SHELL_EVAL_RUNTIMES_SECTION);
    await runtimes.runtime.read();
    expect(
      runtimes.runtime.stage("python.interpreter", { secret: false, value: "bad\u0000path" }).ok,
    ).toBe(false);
    expect(runtimes.state.writes).toHaveLength(0);
  });

  test("CAS conflicts expose the remote value and require an explicit retry choice", async () => {
    const { runtime, state } = createFakeRuntime(SHELL_BASH_SECTION);
    await runtime.read();
    runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 45_000 });
    // Someone else changed the same setting, and the file's revision moved with it.
    state.entries = state.entries.map((entry) =>
      entry.key === "bash.direnvLoadTimeoutMs" ? { ...entry, value: 60_000 } : entry,
    );
    state.revision = "revision-external";
    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(runtime.getSnapshot().phase).toBe("conflict");
    expect(
      runtime
        .getSnapshot()
        .conflict?.remote.entries.find((entry) => entry.key === "bash.direnvLoadTimeoutMs"),
    ).toMatchObject({
      secret: false,
      value: 60_000,
    });
    expect(state.writes[0]?.expectedRevision).toBe("revision-1");
    render(<ShellBashSection runtime={runtime} />);
    expect(screen.getAllByText(SETTINGS_CONFLICT_HEADING, { exact: true })).toHaveLength(1);
    expect(screen.getByText(SETTINGS_CONFLICT_DESCRIPTION, { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload latest" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my edits" })).toBeTruthy();

    runtime.resolveConflict("keep-mine");
    await runtime.save();
    expect(state.writes[1]?.expectedRevision).toBe("revision-external");
    expect(runtime.getSnapshot().phase).toBe("ready");
  });
  test("hides a saved reload status when a partial-save remainder enters external conflict", async () => {
    const descriptor: SettingsSectionDescriptor = {
      ...SHELL_BASH_SECTION,
      controls: SHELL_BASH_SECTION.controls.map((control) =>
        control.key === "bash.enabled" ? { ...control, apply: "reload" as const } : control,
      ),
    };
    const { runtime, state } = createFakeRuntime(descriptor, undefined, undefined, {
      refusedWrites: { "bash.allowCompoundCommands": true },
    });
    await runtime.read();
    render(<ShellBashSection runtime={runtime} />);
    runtime.stage("bash.enabled", { secret: false, value: false });
    runtime.stage("bash.allowCompoundCommands", { secret: false, value: true });
    await expect(runtime.save()).rejects.toMatchObject({
      appError: { message: "The fake settings store refused this write." },
    });
    expect(await screen.findByText("Reload required", { exact: true })).toBeTruthy();
    expect(runtime.getSnapshot().unsavedKeys).toEqual(["bash.allowCompoundCommands"]);

    publishChange(
      state,
      {
        key: "bash.allowCompoundCommands",
        secret: false,
        value: true,
        source: "global",
        overrides: [],
      },
      "revision-conflict-after-partial-save",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("conflict"));
    expect(screen.queryByText("Reload required", { exact: true })).toBeNull();
    expect(screen.getAllByText(SETTINGS_CONFLICT_HEADING, { exact: true })).toHaveLength(1);
  });

  test("Cancel clears unsaved keys after omp refuses the remaining part of a partial save", async () => {
    const { runtime } = createFakeRuntime(SHELL_BASH_SECTION, undefined, undefined, {
      refusedWrites: { "bash.allowCompoundCommands": true },
    });
    await runtime.read();
    render(<ShellBashSection runtime={runtime} />);
    runtime.stage("bash.enabled", { secret: false, value: false });
    runtime.stage("bash.allowCompoundCommands", { secret: false, value: true });
    await expect(runtime.save()).rejects.toMatchObject({
      appError: { message: "The fake settings store refused this write." },
    });
    expect(runtime.getSnapshot().unsavedKeys).toEqual(["bash.allowCompoundCommands"]);
    runtime.cancel();
    expect(runtime.getSnapshot().unsavedKeys).toEqual([]);
  });

  test("a failed partial save keeps the save heading after an earlier external change and failed reread", async () => {
    const { runtime, state } = createFakeRuntime(SHELL_BASH_SECTION, undefined, undefined, {
      refusedWrites: { "bash.allowCompoundCommands": true },
    });
    await runtime.read();
    render(<ShellBashSection runtime={runtime} />);
    const external = state.entries.find((candidate) => candidate.key === "bash.gitGuard");
    if (!external) throw new Error("Shell fixture did not contain bash.gitGuard.");
    if (external.secret) throw new Error("Shell fixture returned a secret gitGuard entry.");
    publishChange(state, { ...external, value: true }, "revision-external-before-save");
    await waitFor(() =>
      expect(runtime.getSnapshot().lastChange?.revision).toBe("revision-external-before-save"),
    );

    state.listFailures = 1;
    runtime.stage("bash.enabled", { secret: false, value: false });
    runtime.stage("bash.allowCompoundCommands", { secret: false, value: true });
    await expect(runtime.save()).rejects.toMatchObject({
      appError: { message: "The fake settings store refused this write." },
    });

    expect(await screen.findByText("Could not save changes", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Could not refresh settings", { exact: true })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "The settings service is not reachable.",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Your changes are still waiting to be saved.",
    );
  });

  test("stage clears a stale conflict after an external refresh failure", async () => {
    const { runtime, state } = createFakeRuntime(SHELL_BASH_SECTION);
    await runtime.read();
    expect(runtime.stage("bash.enabled", { secret: false, value: false }).ok).toBe(true);
    publishChange(
      state,
      { key: "bash.enabled", secret: false, value: false, source: "global", overrides: [] },
      "revision-first-conflict",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("conflict"));

    state.listFailures = 1;
    publishChange(
      state,
      { key: "bash.enabled", secret: false, value: true, source: "global", overrides: [] },
      "revision-refresh-failure",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("error"));

    expect(runtime.stage("bash.allowCompoundCommands", { secret: false, value: true }).ok).toBe(
      true,
    );
    expect(runtime.getSnapshot().phase).toBe("editing");
    expect(runtime.getSnapshot().conflict).toBeNull();
  });
  test("clears Applied when a new edit is staged and when Cancel is pressed", async () => {
    const { runtime } = createFakeRuntime(SHELL_BASH_SECTION);
    await runtime.read();
    render(<ShellBashSection runtime={runtime} />);

    expect(runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 45_000 }).ok).toBe(
      true,
    );
    await runtime.save();
    expect(await screen.findByText("Applied", { exact: true })).toBeTruthy();

    expect(runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 50_000 }).ok).toBe(
      true,
    );
    await waitFor(() => expect(screen.queryByText("Applied", { exact: true })).toBeNull());

    await runtime.save();
    expect(await screen.findByText("Applied", { exact: true })).toBeTruthy();
    runtime.cancel();
    await waitFor(() => expect(screen.queryByText("Applied", { exact: true })).toBeNull());
  });

  test("clears an environment override notification after editing and Cancel through the runtime", async () => {
    const { runtime } = createFakeRuntime(SHELL_EVAL_RUNTIMES_SECTION, undefined, undefined, {
      environmentKeys: { "eval.py": "PI_PY" },
    });
    await runtime.read();

    expect(runtime.stage("eval.py", { secret: false, value: false }).ok).toBe(true);
    await runtime.save();
    const firstOverride = runtime.getSnapshot().environmentOverride;
    if (firstOverride === null || firstOverride === undefined)
      throw new Error("Saving the environment-backed key did not produce its override notice.");
    expect(environmentOverrideText(firstOverride)).toBe(
      "Saved, but omp still uses the environment variable PI_PY until it is removed.",
    );

    expect(runtime.stage("eval.py", { secret: false, value: true }).ok).toBe(true);
    expect(runtime.getSnapshot().environmentOverride).toBeNull();
    await runtime.save();
    const secondOverride = runtime.getSnapshot().environmentOverride;
    if (secondOverride === null || secondOverride === undefined)
      throw new Error("Saving the environment-backed key again did not restore its notice.");
    expect(environmentOverrideText(secondOverride)).toBe(
      "Saved, but omp still uses the environment variable PI_PY until it is removed.",
    );

    runtime.cancel();
    expect(runtime.getSnapshot().environmentOverride).toBeNull();
  });

  test("a failed settings read uses the shared Retry block and recovers", async () => {
    const { runtime, state } = createFakeRuntime(FILES_LSP_SECTION);
    state.listFailures = 1;
    render(<FilesLspSection runtime={runtime} />);

    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("The settings service is not reachable.");
    expect(error.textContent).toContain("Could not load settings");
    await screen.getByRole("button", { name: "Retry" }).click();
    await screen.findByRole("checkbox", { name: "Lazy LSP Startup" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  test("shows a failed retry action's message instead of the earlier read failure", async () => {
    const { runtime, state } = createFakeRuntime(FILES_LSP_SECTION);
    state.listFailures = 1;
    await expect(runtime.read()).rejects.toBeInstanceOf(AppFailure);
    runtime.retry = async () => {
      throw new Error("The retry action failed.");
    };
    render(<FilesLspSection runtime={runtime} />);
    await screen.findByText("Could not load settings", { exact: true });

    await screen.getByRole("button", { name: "Retry" }).click();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The retry action failed.");
    expect(alert.textContent).not.toContain("The settings service is not reachable.");
  });

  test("failed external reads use the refresh heading, not the save heading", async () => {
    const { runtime, state } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    state.listFailures = 1;
    const entry = state.entries.find((candidate) => candidate.key === "lsp.enabled");
    if (!entry) throw new Error("LSP fixture did not contain lsp.enabled.");
    publishChange(state, entry, "revision-external-read-failure");
    await screen.findByText("Could not refresh settings", { exact: true });
    expect(screen.queryByText("Could not save changes", { exact: true })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "The settings service is not reachable.",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Your changes are still waiting to be saved.",
    );
  });

  test("a failed external read with staged edits says the edits are still waiting to be saved", async () => {
    const { runtime, state } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    expect(runtime.stage("lsp.lazy", { secret: false, value: false }).ok).toBe(true);
    state.listFailures = 1;
    const entry = state.entries.find((candidate) => candidate.key === "lsp.enabled");
    if (!entry) throw new Error("LSP fixture did not contain lsp.enabled.");
    publishChange(state, entry, "revision-external-read-failure-with-edit");
    await screen.findByText("Could not refresh settings", { exact: true });
    expect(screen.queryByText("Could not save changes", { exact: true })).toBeNull();
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("The settings service is not reachable.");
    expect(alert).toContain("Your changes are still waiting to be saved.");
    expect(alert).not.toContain("Refresh settings");
  });
  test("conflict banner lists the remote effective setting row", async () => {
    const { runtime } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    const snapshot = runtime.getSnapshot();
    if (!snapshot.config || !snapshot.staged) throw new Error("LSP fixture did not load.");
    const remote = {
      ...snapshot.config,
      entries: snapshot.config.entries.map((entry) =>
        entry.key === "lsp.shared" ? { ...entry, value: true } : entry,
      ),
    };
    const conflictSnapshot = {
      ...snapshot,
      phase: "conflict" as const,
      conflict: {
        local: snapshot.staged,
        remote,
        changedKeys: ["lsp.shared"],
      },
    };
    const conflictRuntime = {
      getSnapshot: () => conflictSnapshot,
      subscribe: () => () => undefined,
    } as unknown as SettingsRuntime;
    render(<FilesLspSection runtime={conflictRuntime} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Shared Language Servers: On · Source: omp's default");
  });

  test("reports Lazy LSP Startup as live and shows Applied after saving", async () => {
    const { runtime } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    expect(runtime.stage("lsp.lazy", { secret: false, value: false }).ok).toBe(true);
    await runtime.save();
    expect(await screen.findByText("Applied", { exact: true })).toBeTruthy();
  });

  test("changed events reconcile effective values and conflict with staged edits", async () => {
    const { runtime, state } = createFakeRuntime(SHELL_EVAL_RUNTIMES_SECTION);
    await runtime.read();
    runtime.stage("eval.tools.enabled", { secret: false, value: false });
    publishChange(
      state,
      { key: "eval.tools.enabled", secret: false, value: false, source: "global", overrides: [] },
      "revision-external",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("conflict"));
    expect(runtime.getSnapshot().conflict?.changedKeys).toEqual(["eval.tools.enabled"]);
    expect(
      runtime
        .getSnapshot()
        .conflict?.remote.entries.find((entry) => entry.key === "eval.tools.enabled")?.source,
    ).toBe("global");
  });

  test("the report states the live boundary and plain-English effects", async () => {
    const { runtime } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    const report = screen.getByLabelText("When settings take effect");
    expect(report.textContent).toContain(
      "Live: LSP, Lazy LSP Startup, Shared Language Servers, Format on Write, Diagnostics on Write, Diagnostics on Edit, Deduplicate Diagnostics.",
    );
    expect(report.textContent).not.toContain("Reload required");
    expect(report.textContent).toContain(
      "New operations use the saved setting; work already underway is not interrupted.",
    );
    expect(
      screen.getByText(
        "Language servers start when first needed if Lazy LSP Startup is on. Turning it off starts them in the background. Shared Language Servers affects new connections; a connected server keeps its current connection. Saving does not interrupt work already running.",
      ),
    ).toBeTruthy();

    cleanup();
    const bash = createFakeRuntime(SHELL_BASH_SECTION);
    await bash.runtime.read();
    render(<ShellBashSection runtime={bash.runtime} />);
    expect(screen.getByLabelText("When settings take effect").textContent).toContain("Live: Bash");
    expect(
      screen.getByText(
        "Changes apply to each new shell command. Saving does not interrupt a command already running.",
      ),
    ).toBeTruthy();

    cleanup();
    const evalRuntime = createFakeRuntime(SHELL_EVAL_RUNTIMES_SECTION);
    await evalRuntime.runtime.read();
    render(<ShellEvalRuntimesSection runtime={evalRuntime.runtime} />);
    expect(screen.getByLabelText("When settings take effect").textContent).toContain("Live:");
    const behaviorNote = screen.getByText(
      "Python and JavaScript evaluations use these options when they run. Existing Python sessions keep running until they close. For parallel tasks, choose whether to start a new helper for every task.",
      { exact: true },
    );
    expect(behaviorNote).toBeTruthy();
    expect(behaviorNote.textContent).not.toMatch(/kernel|workpool/i);
  });

  test("section display keeps unexpected secret payloads out of controls", async () => {
    const hiddenValue = ["not", "visible", "runtime"].join("-");
    const secretEntry = Object.assign(
      { key: "python.interpreter", secret: true, isSet: true, source: "env", overrides: [] },
      { value: hiddenValue },
    ) as unknown as ConfigEntry;
    const initial = SHELL_EVAL_RUNTIMES_SECTION.controls.map((control) => {
      const fixture = expectedByKey[control.key];
      if (!fixture) throw new Error(`Missing default fixture for ${control.key}`);
      return {
        key: control.key,
        secret: false,
        value: fixture.value,
        source: fixture.source,
        overrides: [],
      } satisfies ConfigEntry;
    });
    const entries = initial.map((entry) => (entry.key === secretEntry.key ? secretEntry : entry));
    const { runtime } = createFakeRuntime(SHELL_EVAL_RUNTIMES_SECTION, entries);
    await runtime.read();
    render(<ShellEvalRuntimesSection runtime={runtime} />);
    await screen.findByRole("heading", { name: "Eval and Runtimes" });
    expect(secretSummary(secretEntry)).toEqual({ isSecret: true, isSet: true, source: "env" });
    expect(screen.getByTestId("python.interpreter-provenance").textContent).toContain(
      "Source: Set in the environment",
    );
    expect(screen.queryByDisplayValue(hiddenValue)).toBeNull();
    expect(screen.queryByText(hiddenValue)).toBeNull();
  });
});
