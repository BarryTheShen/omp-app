import type {
  ConfigEntry,
  ConfigWriteResult,
  ConfigWriteValue,
  FolderPath,
  JsonValue,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { SettingsRuntime } from "../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingControl,
  SettingsSectionDescriptor,
} from "../../S1/settings-kit";
import { FilesLspSection } from "../lsp";
import { FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION } from "../sections";
import { ShellBashSection, ShellEvalRuntimesSection } from "./index";

function previewValue(control: SettingControl): JsonValue {
  if (control.secret) throw new Error("The S2.3 preview contains no secret controls.");
  switch (control.kind) {
    case "boolean":
      return true;
    case "enum":
      return control.options?.[0]?.value ?? "";
    case "number":
    case "duration":
      return 500;
    case "list":
      return [];
    case "path":
    case "text":
    case "multiline":
      return "";
    default:
      return [];
  }
}

function previewRuntime(descriptor: SettingsSectionDescriptor): SettingsRuntime {
  const entries: ConfigEntry[] = descriptor.controls.map((control) => ({
    key: control.key,
    secret: false,
    value: previewValue(control),
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

export function S2SectionsPlayground() {
  const [runtimes] = useState(() => ({
    lsp: previewRuntime(FILES_LSP_SECTION),
    bash: previewRuntime(SHELL_BASH_SECTION),
    eval: previewRuntime(SHELL_EVAL_RUNTIMES_SECTION),
  }));

  useEffect(() => {
    return () => {
      runtimes.lsp.dispose();
      runtimes.bash.dispose();
      runtimes.eval.dispose();
    };
  }, [runtimes]);

  return (
    <main className="bg-background text-foreground min-h-screen p-4 sm:p-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Files and Shell settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Language server, Bash, and Eval &amp; Runtimes settings.
          </p>
        </header>
        <FilesLspSection runtime={runtimes.lsp} />
        <ShellBashSection runtime={runtimes.bash} />
        <ShellEvalRuntimesSection runtime={runtimes.eval} />
      </div>
    </main>
  );
}
