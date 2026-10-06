import type {
  ConfigEntry,
  ConfigWriteResult,
  ConfigWriteValue,
  FolderPath,
  JsonValue,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { SettingsRuntime } from "../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
} from "../../S1/settings-kit";
import {
  FILES_EDITING_SECTION,
  FILES_READ_SUMMARIES_SECTION,
  FILES_READING_SECTION,
} from "../sections";
import {
  FilesEditingSection,
  FilesReadingSection,
  FilesReadSummariesSection,
  type FilesSettingsSectionProps,
  useFilesSettingsController,
} from "./index";

function previewValue(control: SettingControl, snapshot: ConfigSnapshot): JsonValue {
  if (control.secret) throw new Error("The Files preview contains no secret controls.");
  if (control.key === "read.summarize.enabled") return false;
  if (control.key === "read.summarize.prose") return true;
  if (control.kind === "boolean") return false;
  if (control.kind === "enum") return control.options?.[0]?.value ?? "";
  if (control.kind === "number" || control.kind === "duration") {
    for (const candidate of [100, 50, 1, 0.5, 0]) {
      const value: SettingValue = { secret: false, value: candidate };
      if (control.validate(value, snapshot).valid) return candidate;
    }
    throw new Error(`The Files preview has no valid numeric value for ${control.label}.`);
  }
  if (control.kind === "path" || control.kind === "text" || control.kind === "multiline") return "";
  return [];
}

function previewRuntime(descriptor: SettingsSectionDescriptor): SettingsRuntime {
  const emptySnapshot: ConfigSnapshot = {
    folder: null,
    revision: "preview-revision-1",
    entries: [],
  };
  const entries: ConfigEntry[] = descriptor.controls.map((control) => ({
    key: control.key,
    secret: false,
    value: previewValue(control, emptySnapshot),
    source: "global",
    overrides: [],
  }));
  let revision = "preview-revision-1";
  let writeNumber = 1;
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async () => ({ entries: [...entries], revision }),
    write: async (args): Promise<ConfigWriteResult> => {
      if (args.expectedRevision !== revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere",
          retryable: true,
        });
      }
      const previousRevision = revision;
      revision = `preview-revision-${++writeNumber}`;
      const value = args.value as ConfigWriteValue;
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
      const index = entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
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
  const changes: ConfigChangeSource = { subscribe: () => () => undefined };
  return new SettingsRuntime(client, changes, { descriptor, folder: null, layer: "global" });
}

function PreviewFilesSection({
  runtime,
  Section,
}: {
  readonly runtime: SettingsRuntime;
  readonly Section: ComponentType<FilesSettingsSectionProps>;
}) {
  const controller = useFilesSettingsController(runtime);
  return <Section {...controller} />;
}

export function FilesPlayground() {
  const [runtimes] = useState(() => ({
    editing: previewRuntime(FILES_EDITING_SECTION),
    reading: previewRuntime(FILES_READING_SECTION),
    summaries: previewRuntime(FILES_READ_SUMMARIES_SECTION),
  }));

  useEffect(() => {
    return () => {
      runtimes.editing.dispose();
      runtimes.reading.dispose();
      runtimes.summaries.dispose();
    };
  }, [runtimes]);

  return (
    <main className="bg-background text-foreground min-h-screen p-4 sm:p-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Files settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            ConfigStore-backed editing, reading, and read summary controls.
          </p>
        </header>
        <PreviewFilesSection runtime={runtimes.editing} Section={FilesEditingSection} />
        <PreviewFilesSection runtime={runtimes.reading} Section={FilesReadingSection} />
        <PreviewFilesSection runtime={runtimes.summaries} Section={FilesReadSummariesSection} />
      </div>
    </main>
  );
}
