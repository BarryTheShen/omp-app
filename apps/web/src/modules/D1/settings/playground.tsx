import type {
  ConfigEntry,
  ConfigWriteArgs,
  ConfigWriteResult,
  JsonValue,
} from "@omp-app/contracts";
import { useMemo } from "react";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingsSectionDescriptor,
} from "@/modules/S1/settings-kit";
import { SettingsRuntime } from "../../S1/runtime";
import type { ModelRef } from "../contract";
import { modelSettingsSections } from "./descriptors";
import { ModelSettingsSurface } from "./model-settings";

function defaultEntry(
  key: string,
  control: SettingsSectionDescriptor["controls"][number],
): ConfigEntry {
  if (control.secret) return { key, secret: true, isSet: false, source: "global", overrides: [] };
  const value: JsonValue =
    control.kind === "boolean"
      ? false
      : control.kind === "enum"
        ? (control.options?.[0]?.value ?? "")
        : control.kind === "number"
          ? 0
          : control.kind === "list"
            ? []
            : "";
  return { key, secret: false, value, source: "global", overrides: [] };
}

function createFixtureRuntime(descriptor: SettingsSectionDescriptor): SettingsRuntime {
  let revision = `fixture-${descriptor.id}`;
  let entries = descriptor.controls.map((control) => defaultEntry(control.key, control));
  const client = {
    read: async (args: { readonly key: string }) =>
      entries.find((entry) => entry.key === args.key) ??
      defaultEntry(
        args.key,
        descriptor.controls[0] ?? {
          key: args.key,
          label: args.key,
          kind: "text",
          secret: false,
          validate: () => ({ valid: true }),
          apply: "restart",
        },
      ),
    list: async () => ({ entries, revision }),
    write: async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
      revision = `${revision}-saved`;
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
      entries = [...entries.filter((item) => item.key !== args.key), entry];
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  } as unknown as ConfigStoreClient;
  const source: ConfigChangeSource = { subscribe: () => () => undefined };
  return new SettingsRuntime(client, source, { descriptor, folder: null, layer: "global" });
}

const sessionModel: ModelRef = { provider: "alpha", modelId: "reasoner-large" };
const defaultModel: ModelRef = { provider: "alpha", modelId: "fast-chat" };

export function ModelSettingsPlayground() {
  const sections = useMemo(
    () =>
      modelSettingsSections.map((descriptor) => ({
        descriptor,
        runtime: createFixtureRuntime(descriptor),
      })),
    [],
  );
  return (
    <ModelSettingsSurface
      sections={sections}
      sessionModel={sessionModel}
      defaultModel={defaultModel}
      defaultSource="global"
      presets={{
        presets: ["balanced"],
        save: async () => undefined,
        switch: async () => undefined,
        remove: async () => undefined,
      }}
    />
  );
}
