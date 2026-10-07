import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  CapabilityStatus,
  type ConfigEntry,
  type ConfigListResult,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  FolderPath as FolderPathSchema,
  type JsonValue,
  type OmpWire,
  type Revision,
  type RpcSessionClient,
  type ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "@/modules/S1/runtime";
import type { ConfigStoreClient } from "@/modules/S1/settings-kit";
import {
  D1_MODEL_CATALOG_RPC_FIXTURE,
  D1_PROJECT_FOLDER_FIXTURE,
  D1_R0_SNAPSHOT_FIXTURE,
  D1_SAVED_DEFAULT_FIXTURE,
  D1_SAVED_DEFAULT_SOURCE_FIXTURE,
  D1_SESSION_MODEL_FIXTURE,
  D1_SET_MODEL_RPC_FIXTURE,
  D1_SETTINGS_CONFIG_FIXTURE,
  D1_THINKING_LEVELS_RPC_FIXTURE,
} from "../fixtures";
import {
  createConfigModelSettingsPort,
  createR0LiveModelState,
  createRpcModelCatalogSource,
  ModelCatalogModel,
  ModelRoleStore,
} from "../model";
import { ModelPicker } from "../model/picker";
import { modelThinkingSection } from "../settings/descriptors";
import { ModelScopeSummary, ModelSettingsSection } from "../settings/model-settings";
import { createRpcThinkingSource, ThinkingLevelsController } from "../thinking";

const threadId = "d1-gate-thread" as ThreadId;
const projectRevisionTwo = "d1-project-config-2" as Revision;

type RpcRequest = {
  readonly threadId: ThreadId;
  readonly command: {
    readonly type: string;
    readonly provider?: string;
    readonly modelId?: string;
    readonly level?: string;
  };
};

function capabilities() {
  const available = (via: "rpc" | "host" = "rpc") =>
    CapabilityStatus.parse({ state: "available", via });
  return {
    "omp.cmd.get_available_models": available(),
    "omp.cmd.set_model": available(),
    "omp.cmd.cycle_model": available(),
    "omp.cmd.get_available_thinking_levels": available(),
    "omp.cmd.set_thinking_level": available(),
    "omp.cmd.cycle_thinking_level": available(),
    "host.config": available("host"),
  };
}

function fakeRpcClient(
  calls: RpcRequest[],
  options: { readonly failCatalog?: boolean } = {},
): AppClient {
  const session = {
    send: async (request: RpcRequest): Promise<unknown> => {
      calls.push(request);
      switch (request.command.type) {
        case "get_available_models":
          if (options.failCatalog) {
            throw new AppFailure({
              code: "unavailable",
              capability: "omp.cmd.get_available_models",
              message: "Model discovery is temporarily unavailable.",
              retryable: true,
            });
          }
          return D1_MODEL_CATALOG_RPC_FIXTURE;
        case "set_model":
          return D1_SET_MODEL_RPC_FIXTURE;
        case "get_available_thinking_levels":
          return D1_THINKING_LEVELS_RPC_FIXTURE;
        case "cycle_thinking_level":
          return null;
        case "set_thinking_level":
          return undefined;
        default:
          throw new Error(`Unexpected D1 RPC command: ${request.command.type}`);
      }
    },
  } as unknown as RpcSessionClient;
  return { port: () => session } as unknown as AppClient;
}

function projectConfigClient(writes: ConfigWriteArgs[]): AppClient {
  let current: ConfigListResult = D1_SETTINGS_CONFIG_FIXTURE;
  let revisionNumber = 1;
  const config: ConfigStoreClient = {
    list: async () => current,
    read: async ({ key }) => {
      const entry = current.entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`No fixture entry for ${key}.`);
      return entry;
    },
    write: async (args): Promise<ConfigWriteResult> => {
      const safeArgs: ConfigWriteArgs = {
        key: args.key,
        layer: args.layer,
        value: args.value as ConfigWriteArgs["value"],
        folder: args.folder === null ? null : FolderPathSchema.parse(args.folder),
        expectedRevision: args.expectedRevision as ConfigWriteArgs["expectedRevision"],
      };
      writes.push(safeArgs);
      if (safeArgs.expectedRevision !== current.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Config revision changed.",
          retryable: true,
        });
      }
      if (safeArgs.value.secret)
        throw new Error("D1 settings fixtures do not write secret values.");
      const previousRevision = current.revision;
      revisionNumber += 1;
      const revision = `d1-project-config-${revisionNumber}` as Revision;
      const entry: ConfigEntry = {
        key: safeArgs.key,
        secret: false,
        value: safeArgs.value.value as JsonValue,
        source: "project",
        overrides: ["global", "default"],
        provenance: {
          origin: "omp-config",
          ompVersion: "18.6.1",
          path: "<WORKSPACE>/.omp/config.yml",
        },
      };
      current = {
        revision,
        entries: [...current.entries.filter((candidate) => candidate.key !== safeArgs.key), entry],
      };
      return {
        key: safeArgs.key,
        layer: safeArgs.layer,
        folder: safeArgs.folder,
        revision,
        previousRevision,
        entry,
      };
    },
  };
  return {
    port: () => config,
    subscribe: async () => ({
      onEvent: () => () => undefined,
      unsubscribe: async () => undefined,
    }),
  } as unknown as AppClient;
}

afterEach(cleanup);

describe("D1 scope, catalog and thinking acceptance", () => {
  test("runs session selection and thinking discovery through omp's exact RPC result shapes", async () => {
    const calls: RpcRequest[] = [];
    const client = fakeRpcClient(calls);
    const catalog = new ModelCatalogModel({
      source: createRpcModelCatalogSource(client, threadId),
      capabilities: capabilities(),
      liveState: createR0LiveModelState({
        getSnapshot: () => D1_R0_SNAPSHOT_FIXTURE.session,
        subscribe: () => () => undefined,
      }),
    });

    await catalog.refresh();
    expect(catalog.getSnapshot()).toMatchObject({
      loadState: "ready",
      current: D1_SESSION_MODEL_FIXTURE,
      models: [{ id: "reasoner-large" }, { id: "fast-chat" }],
    });
    expect(catalog.getSnapshot().models[0]).not.toHaveProperty("baseUrl");
    expect(catalog.getSnapshot().models[0]).not.toHaveProperty("cost");

    const selected = await catalog.apply({ model: D1_SAVED_DEFAULT_FIXTURE, scope: "session" });
    expect(selected).toMatchObject({ model: D1_SAVED_DEFAULT_FIXTURE, scope: "session" });
    expect(catalog.getSnapshot().current).toEqual(D1_SAVED_DEFAULT_FIXTURE);

    const thinking = new ThinkingLevelsController({
      source: createRpcThinkingSource(client, threadId),
      capabilities: capabilities(),
      live: {
        getSnapshot: () => ({
          current: D1_R0_SNAPSHOT_FIXTURE.session.thinkingLevel,
          configured: null,
          reasoning: D1_R0_SNAPSHOT_FIXTURE.session.model?.reasoning ?? false,
        }),
        subscribe: () => () => undefined,
      },
    });
    await thinking.refresh();
    expect(thinking.getSnapshot().levels).toEqual(["off", "low", "medium", "high"]);
    expect(thinking.getSnapshot().levels).not.toContain("inherit");
    await thinking.cycle("forward");
    expect(thinking.getSnapshot().current).toBe("off");

    expect(calls.map((call) => call.command.type)).toEqual([
      "get_available_models",
      "set_model",
      "get_available_thinking_levels",
      "cycle_thinking_level",
      "set_thinking_level",
    ]);
    expect(calls[1]).toMatchObject({
      threadId,
      command: { type: "set_model", provider: "fixture-provider", modelId: "fast-chat" },
    });
    expect(calls[4]).toMatchObject({
      threadId,
      command: { type: "set_thinking_level", level: "off" },
    });

    catalog.dispose();
    thinking.dispose();
  });

  test("keeps reply scope gated and routes saved-default changes through role settings, not set_model", async () => {
    const calls: RpcRequest[] = [];
    const client = fakeRpcClient(calls);
    const catalog = new ModelCatalogModel({
      source: createRpcModelCatalogSource(client, threadId),
      capabilities: capabilities(),
      liveState: createR0LiveModelState({
        getSnapshot: () => D1_R0_SNAPSHOT_FIXTURE.session,
        subscribe: () => () => undefined,
      }),
    });
    await catalog.refresh();

    await expect(
      catalog.apply({ model: D1_SAVED_DEFAULT_FIXTURE, scope: "reply" }),
    ).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.model-per-prompt" },
    });
    await expect(
      catalog.apply({ model: D1_SAVED_DEFAULT_FIXTURE, scope: "default" }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(calls.filter((call) => call.command.type === "set_model")).toHaveLength(0);

    const writes: ConfigWriteArgs[] = [];
    const settings = createConfigModelSettingsPort(projectConfigClient(writes), {
      folder: D1_PROJECT_FOLDER_FIXTURE,
      layer: "project",
    });
    const roles = new ModelRoleStore(settings);
    await roles.read();
    expect(roles.getSnapshot()).toMatchObject({
      layer: "project",
      settings: { modelRoles: { default: "fixture-provider/fast-chat" } },
    });
    await roles.assignRole("default", "fixture-provider/reasoner-large");
    expect(writes).toEqual([
      {
        key: "modelRoles",
        layer: "project",
        folder: D1_PROJECT_FOLDER_FIXTURE,
        value: { secret: false, value: { default: "fixture-provider/reasoner-large" } },
        expectedRevision: D1_SETTINGS_CONFIG_FIXTURE.revision,
      },
    ]);
    expect(roles.getSnapshot().settings.modelRoles.default).toBe("fixture-provider/reasoner-large");
    expect(catalog.getSnapshot().current).toEqual(D1_SESSION_MODEL_FIXTURE);
    expect(calls.filter((call) => call.command.type === "set_model")).toHaveLength(0);

    roles.dispose();
    catalog.dispose();
  });

  test("saves, switches and deletes presets with role maps and configured thinking", async () => {
    const writes: ConfigWriteArgs[] = [];
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(projectConfigClient(writes), {
        folder: D1_PROJECT_FOLDER_FIXTURE,
        layer: "project",
      }),
    );
    await roles.read();
    await roles.assignRole("fast", "fixture-provider/fast-chat");
    await roles.savePreset("balanced");
    expect(roles.getSnapshot().settings.modelPresets.balanced).toEqual({
      modelRoles: {
        default: "fixture-provider/fast-chat",
        fast: "fixture-provider/fast-chat",
      },
      defaultThinkingLevel: "high",
    });

    await roles.assignRole("default", "fixture-provider/reasoner-large");
    await roles.switchPreset("balanced");
    expect(roles.getSnapshot().settings.modelRoles.default).toBe("fixture-provider/fast-chat");
    expect(roles.getSnapshot().settings.defaultThinkingLevel).toBe("high");
    await roles.deletePreset("balanced");
    expect(roles.getSnapshot().settings.modelPresets).not.toHaveProperty("balanced");
    expect(writes.map((write) => write.key)).toEqual([
      "modelRoles",
      "modelPresets",
      "modelRoles",
      "modelRoles",
      "modelPresets",
    ]);
    expect(writes.map((write) => write.expectedRevision)).toEqual([
      D1_SETTINGS_CONFIG_FIXTURE.revision,
      projectRevisionTwo,
      "d1-project-config-3",
      "d1-project-config-4",
      "d1-project-config-5",
    ]);
    roles.dispose();
  });
});

describe("D1 CC4 and CC10 settings surfaces", () => {
  test("shows catalog loading and failure states with accessible status semantics", async () => {
    let resolveCatalog: ((models: readonly OmpWire.ModelInfo[]) => void) | undefined;
    const pendingModels = new Promise<readonly OmpWire.ModelInfo[]>((resolve) => {
      resolveCatalog = resolve;
    });
    const appliedModels: string[] = [];
    const catalog = new ModelCatalogModel({
      source: {
        getAvailableModels: () => pendingModels,
        setModel: async (model) => {
          appliedModels.push(`${model.provider}/${model.modelId}`);
          return D1_SET_MODEL_RPC_FIXTURE;
        },
      },
      capabilities: capabilities(),
    });
    const pendingRefresh = catalog.refresh();
    render(<ModelPicker catalog={catalog} scope="session" />);
    expect(screen.getByRole("status").textContent).toContain("Loading models");
    expect(
      (screen.getByRole("textbox", { name: "Search this session" }) as HTMLInputElement).disabled,
    ).toBe(true);

    await act(async () => {
      resolveCatalog?.(D1_MODEL_CATALOG_RPC_FIXTURE.models);
      await pendingRefresh;
    });
    expect(screen.getByRole("option", { name: /Reasoner Large/ })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Search this session" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(appliedModels).toEqual(["fixture-provider/fast-chat"]));
    expect(document.activeElement).toBe(search);
    catalog.dispose();
    cleanup();

    const failedCalls: RpcRequest[] = [];
    const failedCatalog = new ModelCatalogModel({
      source: createRpcModelCatalogSource(
        fakeRpcClient(failedCalls, { failCatalog: true }),
        threadId,
      ),
      capabilities: capabilities(),
    });
    await expect(failedCatalog.refresh()).rejects.toMatchObject({
      appError: { code: "unavailable", retryable: true },
    });
    render(<ModelPicker catalog={failedCatalog} scope="session" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Model discovery is temporarily unavailable.",
    );
    failedCatalog.dispose();
  });

  test("shows A1 project provenance and keeps the saved default distinct from R0 session state", async () => {
    const config: ConfigStoreClient = {
      list: async () => D1_SETTINGS_CONFIG_FIXTURE,
      read: async ({ key }) => {
        const entry = D1_SETTINGS_CONFIG_FIXTURE.entries.find((candidate) => candidate.key === key);
        if (!entry) throw new Error(`No fixture entry for ${key}.`);
        return entry;
      },
      write: async (args) => {
        throw new Error(`Unexpected settings write for ${args.key}.`);
      },
    };
    const runtime = new SettingsRuntime(
      config,
      { subscribe: () => () => undefined },
      { descriptor: modelThinkingSection, folder: D1_PROJECT_FOLDER_FIXTURE, layer: "project" },
    );
    await runtime.read();
    render(
      <>
        <ModelSettingsSection descriptor={modelThinkingSection} runtime={runtime} />
        <ModelScopeSummary
          sessionModel={D1_SESSION_MODEL_FIXTURE}
          defaultModel={D1_SAVED_DEFAULT_FIXTURE}
          defaultSource={D1_SAVED_DEFAULT_SOURCE_FIXTURE}
        />
      </>,
    );

    expect(screen.getByTestId("defaultThinkingLevel-provenance").textContent).toBe(
      "Source: Saved for this project · overrides settings for all projects, omp's default",
    );
    expect(screen.getByTestId("session-model").textContent).toBe("fixture-provider/reasoner-large");
    expect(screen.getByTestId("default-model").textContent).toBe("fixture-provider/fast-chat");
    expect(screen.getByText("Source: Saved for this project")).toBeTruthy();
    runtime.dispose();
  });
});
