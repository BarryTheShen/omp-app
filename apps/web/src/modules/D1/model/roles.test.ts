import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ConfigEntry,
  type ConfigListResult,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  type JsonValue,
  type Revision,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ModelSettings } from "../contract";
import { createConfigModelSettingsPort, ModelRoleStore } from ".";

const revisionOne = "config-revision-1" as Revision;
const revisionTwo = "config-revision-2" as Revision;

function value(key: string, data: unknown): ConfigEntry {
  return {
    key,
    secret: false,
    value: data as JsonValue,
    source: "global",
    overrides: [],
  } as ConfigEntry;
}

function settings(): ModelSettings {
  return {
    enabledModels: ["alpha/one"],
    enabledProviders: ["alpha"],
    disabledProviders: [],
    modelRoleStorage: "global",
    modelRoles: { default: "alpha/one" },
    modelPresets: {},
    modelTags: {},
    modelProviderOrder: ["alpha"],
    cycleOrder: ["smol", "default", "slow"],
    defaultThinkingLevel: "auto",
  };
}

function entrySet(current: ModelSettings): ConfigEntry[] {
  return [
    value("enabledModels", current.enabledModels),
    value("enabledProviders", current.enabledProviders),
    value("disabledProviders", current.disabledProviders),
    value("modelRoleStorage", current.modelRoleStorage),
    value("modelRoles", current.modelRoles),
    value("modelPresets", current.modelPresets),
    value("modelTags", current.modelTags),
    value("modelProviderOrder", current.modelProviderOrder),
    value("cycleOrder", current.cycleOrder),
    value("defaultThinkingLevel", current.defaultThinkingLevel),
  ];
}

describe("D1 A1.4 ConfigStore role adapter", () => {
  test("reads settings and writes one role-map key with the expected CAS revision", async () => {
    let current = settings();
    const writes: ConfigWriteArgs[] = [];
    const config = {
      list: async (): Promise<ConfigListResult> => ({
        entries: entrySet(current),
        revision: revisionOne,
      }),
      write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
        writes.push(args);
        current = {
          ...current,
          modelRoles: args.value.secret
            ? current.modelRoles
            : (args.value.value as ModelSettings["modelRoles"]),
        };
        return {
          key: args.key,
          layer: args.layer,
          folder: args.folder,
          revision: revisionTwo,
          previousRevision: revisionOne,
          entry: value(args.key, args.value.secret ? null : args.value.value),
        };
      },
    };
    const client = {
      port: () => config,
      subscribe: async () => ({
        onEvent: () => () => undefined,
        unsubscribe: async () => undefined,
      }),
    } as unknown as AppClient;
    const port = createConfigModelSettingsPort(client, { folder: null, layer: "global" });
    const roles = new ModelRoleStore(port);
    await roles.read();
    await roles.assignRole("fast", "alpha/one");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      key: "modelRoles",
      layer: "global",
      folder: null,
      expectedRevision: revisionOne,
      value: { secret: false },
    });
    expect(roles.getSnapshot().settings.modelRoles).toMatchObject({ fast: "alpha/one" });
    expect(roles.getSnapshot().revision).toBe(revisionTwo);
  });

  test("reloads remote roles and exposes conflict instead of overwriting them", async () => {
    let current = settings();
    let shouldConflict = true;
    const config = {
      list: async (): Promise<ConfigListResult> => ({
        entries: entrySet(current),
        revision: revisionOne,
      }),
      write: async (_args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
        if (shouldConflict) {
          shouldConflict = false;
          current = { ...current, modelRoles: { default: "alpha/one", slow: "beta/two" } };
          throw new AppFailure({ code: "conflict", message: "settings changed", retryable: true });
        }
        throw new Error("the conflict path must stop before a second write");
      },
    };
    const client = {
      port: () => config,
      subscribe: async () => ({
        onEvent: () => () => undefined,
        unsubscribe: async () => undefined,
      }),
    } as unknown as AppClient;
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(client, { folder: null, layer: "global" }),
    );
    await roles.read();
    await expect(roles.assignRole("fast", "alpha/one")).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(roles.getSnapshot().status).toBe("conflict");
    expect(roles.getSnapshot().settings.modelRoles).toMatchObject({ slow: "beta/two" });
  });
});
