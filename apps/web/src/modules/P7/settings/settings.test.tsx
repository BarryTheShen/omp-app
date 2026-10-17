import type {
  ConfigChanged,
  ConfigEntry,
  ConfigWriteArgs,
  ConfigWriteResult,
} from "@omp-app/contracts";
import {
  AppFailure,
  ConfigWriteArgs as ConfigWriteArgsSchema,
  FolderPath,
} from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  ScalarSettingControl,
  SettingsSectionDescriptor,
} from "../../S1/settings-kit";
import { SettingsSection } from "../../S1/settings-kit";
import { DEFAULT_COMPACTION_METHOD_ORDER } from "./descriptors";
import {
  CONTEXT_COMPACTION_SETTINGS,
  CONTEXT_EXPERIMENTAL_SETTINGS,
  P7_CONTEXT_SETTINGS_SECTIONS,
} from "./index";

afterEach(cleanup);

const PROJECT_FOLDER = FolderPath.parse("/workspace/context-settings-test");
const EXPECTED_INVENTORY = [
  "S4.context-general",
  "S4.context-compaction",
  "S4.context-rules-ttsr",
  "S4.context-experimental",
] as const;

const EXPECTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  "context/General": [
    "workspace.additionalDirectories",
    "contextPromotion.enabled",
    "extendedContext",
  ],
  "context/Compaction": [
    "compaction.enabled",
    "compaction.midTurnEnabled",
    "compaction.methodOrder",
    "compaction.thresholdPercent",
    "compaction.thresholdTokens",
    "compaction.handoffSaveToDisk",
    "compaction.remoteStreamingV2Enabled",
    "compaction.asyncEnabled",
    "compaction.supersedeReads",
    "compaction.dropUseless",
    "compaction.experimentalContextManagement",
  ],
  "context/Rules (TTSR)": [
    "ttsr.enabled",
    "ttsr.judge",
    "ttsr.contextMode",
    "ttsr.interruptMode",
    "ttsr.repeatMode",
    "ttsr.repeatGap",
    "ttsr.builtinRules",
    "ttsr.disabledRules",
  ],
  "context/Experimental": [
    "snapcompact.systemPrompt",
    "snapcompact.toolResults",
    "tools.format",
    "snapcompact.shape",
  ],
};

function controlFor(descriptor: SettingsSectionDescriptor, key: string): ScalarSettingControl {
  const control = descriptor.controls.find((candidate) => candidate.key === key);
  if (!control || control.kind === "map" || control.kind === "rows") {
    throw new Error(`Missing scalar setting control ${key}.`);
  }
  return control;
}

type FakeConfig = {
  entries: ConfigEntry[];
  revision: string;
  writes: ConfigWriteArgs[];
  conflictNextWrite: boolean;
};

function fakeConfig(initialEntries: readonly ConfigEntry[] = []) {
  const state: FakeConfig = {
    entries: [...initialEntries],
    revision: "p7-revision-1",
    writes: [],
    conflictNextWrite: false,
  };

  function updateEntry(entry: ConfigEntry): void {
    const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
    if (index < 0) state.entries.push(entry);
    else state.entries[index] = entry;
  }

  const client: ConfigStoreClient = {
    async read({ key }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        throw new AppFailure({
          code: "not_found",
          message: "The requested setting was not found.",
          retryable: false,
        });
      }
      return entry;
    },
    async list() {
      return { entries: [...state.entries], revision: state.revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgsSchema.parse(input);
      state.writes.push(args);
      const previousRevision = state.revision;
      if (state.conflictNextWrite) {
        state.conflictNextWrite = false;
        state.revision = "p7-revision-external";
        updateEntry({
          key: args.key,
          secret: false,
          value: false,
          source: "project",
          overrides: ["global", "default"],
        });
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere.",
          retryable: true,
        });
      }
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere.",
          retryable: true,
        });
      }
      state.revision = `p7-revision-${state.writes.length + 1}`;
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
            overrides: args.layer === "project" ? ["global", "default"] : ["default"],
          };
      updateEntry(entry);
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

  const listeners = new Set<(change: ConfigChanged) => void>();
  const source: ConfigChangeSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { state, client, source };
}

function snapshot(entries: readonly ConfigEntry[] = []): ConfigSnapshot {
  return { folder: null, revision: "p7-snapshot-1", entries };
}

const liveRuntimes: SettingsRuntime[] = [];

afterEach(() => {
  for (const runtime of liveRuntimes.splice(0)) runtime.dispose();
});

describe("P7 context settings sections", () => {
  test("claims each S4 inventory row once and includes every source-backed setting", () => {
    const covered = P7_CONTEXT_SETTINGS_SECTIONS.flatMap((section) => section.inventory);
    expect(covered).toEqual(EXPECTED_INVENTORY);
    expect(new Set(covered).size).toBe(covered.length);

    for (const section of P7_CONTEXT_SETTINGS_SECTIONS) {
      expect(section.controls.map((control) => control.key)).toEqual(
        EXPECTED_KEYS[section.section],
      );
      expect(section.requires).toContain("host.config");
      for (const control of section.controls) {
        expect(control.secret).toBe(false);
        expect(control.apply).toBe("live");
      }
    }
  });
  test("does not offer branch summaries or idle compaction controls the app cannot run", () => {
    const keys = P7_CONTEXT_SETTINGS_SECTIONS.flatMap((section) =>
      section.controls.map((control) => control.key),
    );
    expect(keys).not.toContain("branchSummary.enabled");
    expect(keys).not.toContain("compaction.idleEnabled");
    expect(keys).not.toContain("compaction.idleThresholdTokens");
    expect(keys).not.toContain("compaction.idleTimeoutSeconds");
  });

  test("validates numeric choices and ordered compaction methods without exposing raw option codes", () => {
    const threshold = controlFor(CONTEXT_COMPACTION_SETTINGS, "compaction.thresholdPercent");
    expect(threshold.validate({ secret: false, value: 70 }, snapshot())).toEqual({ valid: true });
    expect(threshold.validate({ secret: false, value: "70" }, snapshot())).toEqual({ valid: true });
    expect(threshold.validate({ secret: false, value: 71 }, snapshot()).valid).toBe(true);
    expect(threshold.validate({ secret: false, value: "soon" }, snapshot()).valid).toBe(false);

    const order = controlFor(CONTEXT_COMPACTION_SETTINGS, "compaction.methodOrder");
    expect(
      order.validate({ secret: false, value: [...DEFAULT_COMPACTION_METHOD_ORDER] }, snapshot())
        .valid,
    ).toBe(true);
    expect(order.validate({ secret: false, value: ["remote", "remote"] }, snapshot()).valid).toBe(
      false,
    );
    expect(order.options?.map((option) => option.label)).toEqual([
      "Server compaction",
      "Snapcompact",
      "Handoff",
      "Soft compaction",
      "Shake",
    ]);
  });

  test("renders readable choice labels instead of stored snapcompact shape values", () => {
    const config = snapshot([
      {
        key: "snapcompact.shape",
        secret: false,
        value: "8x8r-bw",
        source: "global",
        overrides: ["default"],
      },
    ]);
    render(<SettingsSection descriptor={CONTEXT_EXPERIMENTAL_SETTINGS} snapshot={config} />);

    expect(screen.getByText("8×8 repeated, black")).toBeTruthy();
    expect(screen.queryByText("8x8r-bw")).toBeNull();
  });
});

describe("P7 settings through ConfigStore", () => {
  test("saves only staged values using the chosen scope and successive CAS revisions", async () => {
    const store = fakeConfig([
      {
        key: "compaction.enabled",
        secret: false,
        value: true,
        source: "global",
        overrides: ["default"],
      },
      {
        key: "compaction.thresholdPercent",
        secret: false,
        value: 70,
        source: "global",
        overrides: ["default"],
      },
    ]);
    const runtime = new SettingsRuntime(store.client, store.source, {
      descriptor: CONTEXT_COMPACTION_SETTINGS,
      folder: PROJECT_FOLDER,
      layer: "project",
    });
    liveRuntimes.push(runtime);

    await runtime.read();
    runtime.stage("compaction.enabled", { secret: false, value: false });
    runtime.stage("compaction.thresholdPercent", { secret: false, value: 50 });
    const result = await runtime.save();

    expect(store.state.writes.map((write) => write.key)).toEqual([
      "compaction.enabled",
      "compaction.thresholdPercent",
    ]);
    expect(store.state.writes).toMatchObject([
      {
        layer: "project",
        folder: PROJECT_FOLDER,
        expectedRevision: "p7-revision-1",
        value: { secret: false, value: false },
      },
      {
        layer: "project",
        folder: PROJECT_FOLDER,
        expectedRevision: "p7-revision-2",
        value: { secret: false, value: 50 },
      },
    ]);
    expect(result.status).toBe("applied");
    expect(runtime.getSnapshot().config?.entries).toContainEqual(
      expect.objectContaining({
        key: "compaction.thresholdPercent",
        value: 50,
        source: "project",
      }),
    );
  });

  test("surfaces a compare-and-swap conflict and preserves the staged choice until resolution", async () => {
    const store = fakeConfig([
      {
        key: "compaction.enabled",
        secret: false,
        value: true,
        source: "global",
        overrides: ["default"],
      },
    ]);
    const runtime = new SettingsRuntime(store.client, store.source, {
      descriptor: CONTEXT_COMPACTION_SETTINGS,
      folder: PROJECT_FOLDER,
      layer: "project",
    });
    liveRuntimes.push(runtime);

    await runtime.read();
    runtime.stage("compaction.enabled", { secret: false, value: true });
    store.state.conflictNextWrite = true;
    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(runtime.getSnapshot().conflict?.changedKeys).toEqual(["compaction.enabled"]);
    expect(runtime.getSnapshot().conflict?.local.edits["compaction.enabled"]).toEqual({
      secret: false,
      value: true,
    });

    runtime.resolveConflict("reload");
    expect(runtime.getSnapshot().staged?.edits).toEqual({});
  });
});
