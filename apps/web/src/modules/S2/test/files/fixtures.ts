import type {
  ConfigChanged,
  ConfigEntry,
  ConfigSource,
  ConfigWriteArgs,
  ConfigWriteLayer,
  ConfigWriteResult,
  ConfigWriteValue,
  FolderPath,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { SettingsRuntime } from "../../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import { FILES_SETTING_DEFAULTS, hasFilesSettingDefault } from "../../files/defaults";

export function defaultFilesEntries(descriptor: SettingsSectionDescriptor): readonly ConfigEntry[] {
  return descriptor.controls.map((control) => {
    if (!hasFilesSettingDefault(control.key))
      throw new Error(`Missing pinned Files setting ${control.key}`);
    return {
      key: control.key,
      secret: false,
      value: FILES_SETTING_DEFAULTS[control.key].value,
      source: "default",
      overrides: [],
    };
  });
}

export function filesSnapshot(
  descriptor: SettingsSectionDescriptor,
  entries: readonly ConfigEntry[] = defaultFilesEntries(descriptor),
  folder: FolderPath | null = null,
): {
  readonly folder: FolderPath | null;
  readonly revision: string;
  readonly entries: readonly ConfigEntry[];
} {
  return { folder, revision: "files-policy-revision", entries };
}

export type FilesFakeStore = {
  revision: string;
  folder: FolderPath | null;
  entries: ConfigEntry[];
  writes: ConfigWriteArgs[];
  listeners: Set<(change: ConfigChanged) => void>;
  listError: AppFailure | null;
};

export function createFilesRuntime(
  descriptor: SettingsSectionDescriptor,
  entries: readonly ConfigEntry[] = defaultFilesEntries(descriptor),
  scope: { readonly folder: FolderPath | null; readonly layer: ConfigWriteLayer } = {
    folder: null,
    layer: "global",
  },
) {
  const state: FilesFakeStore = {
    revision: "revision-1",
    folder: scope.folder,
    entries: entries.map((entry) => ({ ...entry })),
    writes: [],
    listeners: new Set(),
    listError: null,
  };
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async () => {
      if (state.listError) throw state.listError;
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
  return { runtime, state };
}

export function publishFilesChange(
  state: FilesFakeStore,
  entry: ConfigEntry,
  revision: string,
  layer: ConfigSource = "global",
): void {
  state.revision = revision;
  const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
  if (index < 0) state.entries.push(entry);
  else state.entries[index] = entry;
  const change: ConfigChanged = { key: entry.key, layer, folder: state.folder, revision, entry };
  for (const listener of state.listeners) listener(change);
}
