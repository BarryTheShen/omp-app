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

// Defaults/types come from the pinned registration; consumer locations justify the live/reload policy.
const DEFAULTS: readonly DefaultFixture[] = [
  {
    key: "lsp.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:8-18; tools/index.ts:751-752; sdk.ts:4988-4993",
  },
  {
    key: "lsp.lazy",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:20-31; sdk.ts:4980-4993,5032-5035",
  },
  {
    key: "lsp.shared",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:33-44; sdk.ts:4968-4976",
  },
  {
    key: "lsp.formatOnWrite",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:46-56; edit/index.ts:172-177; write.ts:486-490",
  },
  {
    key: "lsp.diagnosticsOnWrite",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "lsp/settings.ts:58-68; write.ts:486-490",
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
    citation: "lsp/settings.ts:82-92; write.ts:486-492; lsp/deferred-diagnostics.ts:42-45",
  },
  {
    key: "bash.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:82-92; tools/index.ts:751-752",
  },
  {
    key: "bash.allowCompoundCommands",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:94-105; tools/bash.ts:506-511",
  },
  {
    key: "bash.autoBackground.enabled",
    value: true,
    source: "runtime",
    kind: "boolean",
    citation: "exec/settings.ts:107-118; main.ts:246-254; tools/bash.ts:603,1142-1147",
  },
  {
    key: "bash.patterns",
    value: [],
    source: "default",
    citation: "exec/settings.ts:120-131; tools/bash.ts:237-240,260-271,507-508",
  },
  {
    key: "bashInterceptor.enabled",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:134-144; tools/bash.ts:996-1002",
  },
  {
    key: "bash.direnv",
    value: "auto",
    source: "default",
    kind: "enum",
    citation: "exec/settings.ts:152-164; exec/bash-executor.ts:549-555",
  },
  {
    key: "bash.direnvLoadTimeoutMs",
    value: 30_000,
    source: "default",
    kind: "duration",
    citation: "exec/settings.ts:166-177; exec/bash-executor.ts:549-554",
  },
  {
    key: "shellMinimizer.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "exec/settings.ts:180-190; exec/bash-executor.ts:536",
  },
  {
    key: "shellMinimizer.sourceOutlineLevel",
    value: "default",
    source: "default",
    kind: "enum",
    citation: "exec/settings.ts:216-227; exec/bash-executor.ts:301-303,536",
  },
  {
    key: "eval.py",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:8-19; tools/eval-backends.ts:10-15",
  },
  {
    key: "eval.js",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:21-32; tools/eval-backends.ts:10-15",
  },
  {
    key: "eval.autoProvision",
    value: true,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:34-45; tools/eval.ts:402-403; eval/js/executor.ts:139",
  },
  {
    key: "eval.tools.enabled",
    value: true,
    source: "default",
    kind: "boolean",
    citation:
      "eval/settings.ts:46-58; task/eval-tools.ts:79-82; session/agent-session.ts:6850-6852",
  },
  {
    key: "eval.workpool.freshAgents",
    value: false,
    source: "default",
    kind: "boolean",
    citation: "eval/settings.ts:59-69; task/workpool.ts:140-143",
  },
  {
    key: "eval.autoBackground.enabled",
    value: false,
    source: "runtime",
    kind: "boolean",
    citation: "eval/settings.ts:71-82; main.ts:246-254; tools/eval.ts:397-403,606-607",
  },
  {
    key: "python.kernelMode",
    value: "session",
    source: "default",
    kind: "enum",
    citation: "eval/settings.ts:92-103; eval/py/index.ts:50-70; eval/py/executor.ts:599-603",
  },
  {
    key: "python.interpreter",
    value: "",
    source: "default",
    kind: "path",
    citation: "eval/settings.ts:105-116; eval/py/index.ts:21-37; eval/py/executor.ts:413-415",
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
) {
  const state: FakeStore = {
    revision: "revision-1",
    entries: entries.map((entry) => ({ ...entry })),
    writes: [],
    listeners: new Set(),
  };
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async () => ({ entries: [...state.entries], revision: state.revision }),
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
      const previousRevision = state.revision;
      const revision = `revision-${state.writes.length + 1}`;
      state.revision = revision;
      const entry: ConfigEntry = value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: value.action === "set",
            source: args.layer,
            overrides: [],
          }
        : {
            key: args.key,
            secret: false,
            value: value.value,
            source: args.layer,
            overrides: [],
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
  test("hides a stale Applied pill when a later edit enters conflict", async () => {
    const { runtime, state } = createFakeRuntime(SHELL_BASH_SECTION);
    await runtime.read();
    render(<ShellBashSection runtime={runtime} />);
    const first = runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 45_000 });
    expect(first.ok).toBe(true);
    await runtime.save();
    expect(await screen.findByText("Applied", { exact: true })).toBeTruthy();

    const second = runtime.stage("bash.direnvLoadTimeoutMs", { secret: false, value: 50_000 });
    expect(second.ok).toBe(true);
    publishChange(
      state,
      {
        key: "bash.direnvLoadTimeoutMs",
        secret: false,
        value: 60_000,
        source: "global",
        overrides: [],
      },
      "revision-external",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("conflict"));
    expect(screen.queryByText("Applied", { exact: true })).toBeNull();
    expect(screen.getAllByText(SETTINGS_CONFLICT_HEADING, { exact: true })).toHaveLength(1);
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

  test("uses the shared reload-required apply-status label", async () => {
    const { runtime } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    expect(runtime.stage("lsp.lazy", { secret: false, value: false }).ok).toBe(true);
    await runtime.save();
    expect(await screen.findByText("Reload required", { exact: true })).toBeTruthy();
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

  test("the report groups the live/reload boundaries from the descriptors", async () => {
    const { runtime } = createFakeRuntime(FILES_LSP_SECTION);
    await runtime.read();
    render(<FilesLspSection runtime={runtime} />);
    const report = screen.getByLabelText("When settings take effect");
    expect(report.textContent).toContain("Reload required: Lazy LSP Startup");
    expect(report.textContent).toContain("Live: LSP, Shared Language Servers");
    expect(
      screen.getByText(/already-running ones keep their transport until they exit or go idle/i),
    ).toBeTruthy();

    cleanup();
    const bash = createFakeRuntime(SHELL_BASH_SECTION);
    await bash.runtime.read();
    render(<ShellBashSection runtime={bash.runtime} />);
    expect(screen.getByLabelText("When settings take effect").textContent).toContain(
      "Live: Bash, Allow Compound Commands",
    );
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
