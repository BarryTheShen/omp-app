import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigWriteResult,
  FolderPath,
  JsonValue,
} from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../S1/runtime";
import {
  type ConfigChangeSource,
  type ConfigSnapshot,
  type ConfigStoreClient,
  readSection,
  type ScalarSettingControl,
  SettingsSection,
  type StagedSettings,
  stage,
} from "../../S1/settings-kit";
import { redactMcpServerConfig } from "../contract";
import {
  I1_SETTINGS_SECTIONS,
  MCP_SETTING_KEYS,
  MCP_SETTINGS_CONFIG,
  MCP_SETTINGS_SECTION_DESCRIPTOR,
} from ".";

/** omp v18.12.6 defaults from mcp/settings.ts:12,24,36,49,61 and tools/settings.ts:964,978,1000. */
const DEFAULT_VALUES = {
  "mcp.enableProjectConfig": true,
  "mcp.startupTimeoutMs": 250,
  "mcp.renderMarkdownResults": true,
  "mcp.notifications": false,
  "mcp.notificationDebounceMs": 500,
  "tools.xdev": true,
  "tools.xdevDocs": "catalog",
  "tools.xdevInlineDevices": [],
} satisfies Readonly<Record<string, JsonValue>>;

const EXTRA_SECRET: ConfigEntry = {
  key: "mcp.oauth.clientSecret",
  secret: true,
  isSet: true,
  source: "project",
  overrides: [],
  provenance: { origin: "omp-config", ompVersion: "18.6.1" },
};

type FakeState = {
  revision: string;
  entries: ConfigEntry[];
  writes: Array<Parameters<ConfigStoreClient["write"]>[0]>;
  listeners: Set<(change: ConfigChanged) => void>;
};

function fakeState(defaultValues: Readonly<Record<string, JsonValue>>): FakeState {
  const entries = Object.entries(defaultValues).map(([key, value]): ConfigEntry => {
    const entry: ConfigEntry = {
      key,
      secret: false,
      value,
      source: "default",
      overrides: [],
      provenance: { origin: "host-fallback", ompVersion: "18.6.1" },
    };
    return entry;
  });
  return {
    revision: "revision-1",
    entries: [...entries, EXTRA_SECRET],
    writes: [],
    listeners: new Set(),
  };
}

function fakeConfigStore(state: FakeState): ConfigStoreClient {
  return {
    async read({ key }) {
      const entry = state.entries.find((item) => item.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    async list() {
      return { entries: [...state.entries], revision: state.revision };
    },
    async write(args): Promise<ConfigWriteResult> {
      state.writes.push(args);
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "The settings changed elsewhere.",
          retryable: true,
        });
      }
      if (args.value.secret) {
        throw new AppFailure({
          code: "invalid_args",
          message: "The MCP settings in this section are not secrets.",
          retryable: false,
        });
      }
      const previousRevision = state.revision;
      const revision = `revision-${state.writes.length + 1}`;
      const entry: ConfigEntry = {
        key: args.key,
        secret: false,
        value: JsonValue.parse(args.value.value),
        source: args.layer,
        overrides: [],
        provenance: { origin: "omp-config", ompVersion: "18.6.1" },
      };
      state.revision = revision;
      const index = state.entries.findIndex((item) => item.key === args.key);
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder === null ? null : FolderPath.parse(args.folder),
        revision,
        previousRevision,
        entry,
      };
    },
  };
}

const runtimes: SettingsRuntime[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function createRuntime(state: FakeState): SettingsRuntime {
  const changes: ConfigChangeSource = {
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  const runtime = new SettingsRuntime(fakeConfigStore(state), changes, {
    descriptor: MCP_SETTINGS_SECTION_DESCRIPTOR,
    folder: null,
    layer: "global",
  });
  runtimes.push(runtime);
  return runtime;
}

describe("I1 Discovery and MCP settings", () => {
  test("publishes the complete typed section and the v18.9.1 controls", () => {
    expect(MCP_SETTINGS_CONFIG).toEqual({
      section: "tools/Discovery & MCP",
      keys: [...MCP_SETTING_KEYS],
    });
    expect(I1_SETTINGS_SECTIONS).toEqual([MCP_SETTINGS_SECTION_DESCRIPTOR]);
    expect(MCP_SETTINGS_SECTION_DESCRIPTOR).toMatchObject({
      id: "I1.mcpSettings",
      section: "tools/Discovery & MCP",
      title: "Discovery and MCP",
      inventory: ["S5.tools-discovery-mcp"],
      requires: ["host.config"],
    });
    const scalarControls = MCP_SETTINGS_SECTION_DESCRIPTOR.controls.filter(
      (control): control is ScalarSettingControl =>
        control.kind !== "map" && control.kind !== "rows",
    );
    expect(MCP_SETTINGS_SECTION_DESCRIPTOR.controls.map((control) => control.key)).toEqual(
      Object.keys(DEFAULT_VALUES),
    );
    expect(
      Object.fromEntries(scalarControls.map((control) => [control.key, control.kind])),
    ).toEqual({
      "mcp.enableProjectConfig": "boolean",
      "mcp.startupTimeoutMs": "number",
      "mcp.renderMarkdownResults": "boolean",
      "mcp.notifications": "boolean",
      "mcp.notificationDebounceMs": "number",
      "tools.xdev": "boolean",
      "tools.xdevDocs": "enum",
      "tools.xdevInlineDevices": "list",
    });
    expect(
      Object.fromEntries(scalarControls.map((control) => [control.key, control.apply])),
    ).toEqual({
      "mcp.enableProjectConfig": "live",
      "mcp.startupTimeoutMs": "restart",
      "mcp.renderMarkdownResults": "live",
      "mcp.notifications": "live",
      "mcp.notificationDebounceMs": "live",
      "tools.xdev": "live",
      "tools.xdevDocs": "live",
      "tools.xdevInlineDevices": "live",
    });
    expect(scalarControls.find((control) => control.key === "tools.xdevDocs")?.options).toEqual([
      { value: "inline", label: "All Devices" },
      { value: "builtins", label: "Built-ins Only" },
      { value: "catalog", label: "Catalog Only" },
    ]);
    expect(
      scalarControls.find((control) => control.key === "mcp.renderMarkdownResults")?.description,
    ).toBe(
      "Terminal only. The app does not use this setting; it only affects omp's terminal renderer.",
    );
  });

  test("reads ConfigStore defaults with provenance and renders their effective values through S1", async () => {
    const state = fakeState(DEFAULT_VALUES);
    const snapshot = await readSection(
      fakeConfigStore(state),
      MCP_SETTINGS_SECTION_DESCRIPTOR,
      null,
    );
    expect(snapshot.entries).toHaveLength(8);
    expect(snapshot.entries.map((entry) => entry.key)).toEqual([...MCP_SETTING_KEYS]);
    expect(snapshot.entries.map((entry) => entry.source)).toEqual(Array(8).fill("default"));
    expect(snapshot.entries.map((entry) => entry.provenance?.origin)).toEqual(
      Array(8).fill("host-fallback"),
    );
    expect(snapshot.entries.map((entry) => entry.provenance?.ompVersion)).toEqual(
      Array(8).fill("18.6.1"),
    );
    expect(snapshot.entries.map((entry) => entry.provenance?.path)).toEqual(
      Array(8).fill(undefined),
    );
    expect(
      Object.fromEntries(
        snapshot.entries.map((entry) => {
          if (entry.secret) throw new Error("A non-secret MCP setting was redacted.");
          return [entry.key, entry.value];
        }),
      ),
    ).toEqual(DEFAULT_VALUES);
    expect(snapshot.entries).not.toContain(EXTRA_SECRET);

    const config: ConfigSnapshot = snapshot;
    const staged: StagedSettings = { snapshot: config, edits: {} };
    render(
      <SettingsSection
        descriptor={MCP_SETTINGS_SECTION_DESCRIPTOR}
        snapshot={config}
        staged={staged}
      />,
    );
    expect(screen.getByRole("heading", { name: "Discovery and MCP" })).toBeTruthy();
    expect(screen.getAllByText("Source: omp's default")).toHaveLength(8);
    expect(screen.getByDisplayValue("250")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").map((input) => input.matches(":checked"))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(
      screen.getByRole("combobox").querySelector("option:checked")?.getAttribute("value"),
    ).toBe("catalog");
  });

  test("validates non-negative discovery values, enum choices, and string-list entries", async () => {
    const state = fakeState(DEFAULT_VALUES);
    const snapshot = await readSection(
      fakeConfigStore(state),
      MCP_SETTINGS_SECTION_DESCRIPTOR,
      null,
    );
    const staged: StagedSettings = { snapshot, edits: {} };
    expect(
      stage(MCP_SETTINGS_SECTION_DESCRIPTOR, staged, "mcp.startupTimeoutMs", {
        secret: false,
        value: -1,
      }).ok,
    ).toBe(false);
    expect(
      stage(MCP_SETTINGS_SECTION_DESCRIPTOR, staged, "tools.xdevDocs", {
        secret: false,
        value: "unsupported",
      }).ok,
    ).toBe(false);
    expect(
      stage(MCP_SETTINGS_SECTION_DESCRIPTOR, staged, "tools.xdevInlineDevices", {
        secret: false,
        value: ["mcp__*"],
      }).ok,
    ).toBe(true);
    expect(
      stage(MCP_SETTINGS_SECTION_DESCRIPTOR, staged, "tools.xdevInlineDevices", {
        secret: false,
        value: ["valid", 1],
      }).ok,
    ).toBe(false);
  });

  test("writes one-key CAS updates and resolves a stale-write conflict against the new revision", async () => {
    const state = fakeState(DEFAULT_VALUES);
    const runtime = createRuntime(state);
    await runtime.read();
    expect(runtime.stage("mcp.enableProjectConfig", { secret: false, value: false }).ok).toBe(true);
    const applied = await runtime.save();
    expect(applied.status).toBe("applied");
    expect(state.writes[0]).toMatchObject({
      key: "mcp.enableProjectConfig",
      layer: "global",
      folder: null,
      expectedRevision: "revision-1",
      value: { secret: false, value: false },
    });

    const conflictingState = fakeState(DEFAULT_VALUES);
    const conflictRuntime = createRuntime(conflictingState);
    await conflictRuntime.read();
    expect(conflictRuntime.stage("mcp.startupTimeoutMs", { secret: false, value: 0 }).ok).toBe(
      true,
    );
    conflictingState.revision = "revision-external";
    conflictingState.entries = conflictingState.entries.map((entry) =>
      entry.key === "mcp.startupTimeoutMs"
        ? {
            key: entry.key,
            secret: false,
            value: 300,
            source: "global",
            overrides: ["default"],
            provenance: { origin: "omp-config", ompVersion: "18.6.1" },
          }
        : entry,
    );

    await expect(conflictRuntime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(conflictRuntime.getSnapshot().phase).toBe("conflict");
    expect(conflictRuntime.getSnapshot().conflict?.changedKeys).toEqual(["mcp.startupTimeoutMs"]);
    expect(
      conflictRuntime
        .getSnapshot()
        .conflict?.remote.entries.find((entry) => entry.key === "mcp.startupTimeoutMs"),
    ).toMatchObject({ value: 300, source: "global" });

    conflictRuntime.resolveConflict("keep-mine");
    const retried = await conflictRuntime.save();
    expect(retried.status).toBe("restart-required");
    expect(conflictingState.writes.map((write) => write.expectedRevision)).toEqual([
      "revision-1",
      "revision-external",
    ]);
    expect(conflictRuntime.getSnapshot().phase).toBe("ready");
  });

  test("redacts MCP environment values, header values, and URL query credentials", () => {
    const environmentToken = ["sk", "ant", "k".repeat(30)].join("-");
    const headerToken = ["Bearer", "t".repeat(32)].join(" ");
    const safe = redactMcpServerConfig({
      name: "private-server",
      scope: "project",
      transport: "http",
      enabled: true,
      status: "configured",
      url: `https://mcp.example.test/endpoint?token=${environmentToken}`,
      auth: "api-key",
      source: { origin: "project", path: "/home/private/.omp/mcp.json", reloadRequired: true },
      env: { MCP_TOKEN: environmentToken },
      headers: { authorization: headerToken },
    });

    expect(safe).toMatchObject({
      name: "private-server",
      scope: "project",
      url: "https://mcp.example.test",
      auth: "api-key",
      source: { origin: "project", reloadRequired: true },
      envKeys: ["MCP_TOKEN"],
      headers: ["authorization"],
    });
    expect(JSON.stringify(safe)).not.toContain(environmentToken);
    expect(JSON.stringify(safe)).not.toContain(headerToken);
    expect(JSON.stringify(safe)).not.toContain("/home/private");
  });
});
