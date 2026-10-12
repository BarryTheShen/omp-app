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
import { createConfigModelSettingsPort, ModelRoleStore, PRESET_NAME_RULE } from ".";

const revisionOne = "config-revision-1" as Revision;
const revisionTwo = "config-revision-2" as Revision;
const revisionThree = "config-revision-3" as Revision;

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

function clientOver(config: unknown): AppClient {
  return {
    port: () => config,
    subscribe: async () => ({
      onEvent: () => () => undefined,
      unsubscribe: async () => undefined,
    }),
  } as unknown as AppClient;
}

/** The settings as the ConfigStore keeps them: a write replaces its key's value. */
function applyWrite(current: ModelSettings, args: ConfigWriteArgs): ModelSettings {
  if (args.value.secret) return current;
  return { ...current, [args.key]: args.value.value } as ModelSettings;
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
        current = applyWrite(current, args);
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
    const port = createConfigModelSettingsPort(clientOver(config), {
      folder: null,
      layer: "global",
    });
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
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(clientOver(config), { folder: null, layer: "global" }),
    );
    await roles.read();
    await expect(roles.assignRole("fast", "alpha/one")).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(roles.getSnapshot().status).toBe("conflict");
    expect(roles.getSnapshot().settings.modelRoles).toMatchObject({ slow: "beta/two" });
  });

  test("a conflict that only moved the file's revision is answered once with the same change", async () => {
    // The app writes its recent models into the same ConfigStore, and the revision covers every layer:
    // the first write fails although no model setting changed, so the change is applied again on what is saved.
    let current = settings();
    let revision = revisionOne;
    const writes: ConfigWriteArgs[] = [];
    const config = {
      list: async (): Promise<ConfigListResult> => ({
        entries: entrySet(current),
        revision,
      }),
      write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
        writes.push(args);
        if (writes.length === 1) {
          revision = revisionTwo;
          throw new AppFailure({
            code: "conflict",
            message: "Cannot write configuration: the file changed.",
            retryable: true,
          });
        }
        if (args.expectedRevision !== revision) {
          throw new AppFailure({ code: "conflict", message: "stale", retryable: true });
        }
        current = applyWrite(current, args);
        revision = revisionThree;
        return {
          key: args.key,
          layer: args.layer,
          folder: args.folder,
          revision,
          previousRevision: revisionTwo,
          entry: value(args.key, args.value.secret ? null : args.value.value),
        };
      },
    };
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(clientOver(config), { folder: null, layer: "global" }),
    );
    await roles.read();
    await roles.assignRole("default", "beta/two");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ expectedRevision: revisionTwo });
    expect(roles.getSnapshot().status).toBe("ready");
    expect(roles.getSnapshot().settings.modelRoles).toEqual({ default: "beta/two" });
    expect(roles.getSnapshot().revision).toBe(revisionThree);
  });

  test("a preset name omp would refuse is refused before anything is written", async () => {
    let current = settings();
    const writes: ConfigWriteArgs[] = [];
    const config = {
      list: async (): Promise<ConfigListResult> => ({
        entries: entrySet(current),
        revision: revisionOne,
      }),
      write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
        writes.push(args);
        current = applyWrite(current, args);
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
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(clientOver(config), { folder: null, layer: "global" }),
    );
    await roles.read();
    for (const name of ["My work setup", "9lives", "work.setup", "-x"]) {
      await expect(roles.savePreset(name)).rejects.toMatchObject({
        appError: { code: "invalid_args", message: PRESET_NAME_RULE },
      });
    }
    expect(writes).toHaveLength(0);
    await roles.savePreset("work_setup-2");
    expect(writes).toHaveLength(1);
    expect(roles.getSnapshot().settings.modelPresets).toMatchObject({
      "work_setup-2": { modelRoles: { default: "alpha/one" } },
    });
  });

  test("switching a preset that has no thinking level keeps the saved one", async () => {
    let current: ModelSettings = {
      ...settings(),
      defaultThinkingLevel: "low",
      modelPresets: { plain: { modelRoles: { default: "beta/two" } } },
    };
    const config = {
      list: async (): Promise<ConfigListResult> => ({
        entries: entrySet(current),
        revision: revisionOne,
      }),
      write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
        current = applyWrite(current, args);
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
    const roles = new ModelRoleStore(
      createConfigModelSettingsPort(clientOver(config), { folder: null, layer: "global" }),
    );
    await roles.read();
    await roles.switchPreset("plain");
    expect(current.modelRoles).toEqual({ default: "beta/two" });
    expect(current.defaultThinkingLevel).toBe("low");
  });
});
