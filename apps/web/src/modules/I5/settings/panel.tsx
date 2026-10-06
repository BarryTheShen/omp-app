import type { ConfigWriteLayer, FolderPath } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useCallback, useEffect, useState } from "react";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingsSectionDescriptor,
  StagedSettings,
  ValidationResult,
} from "../../S1/settings-kit";
import {
  commit,
  readSection,
  SettingsSection,
  saveLocationText,
  subscribeChanged,
} from "../../S1/settings-kit";
import { I5_SETTINGS_SECTIONS } from "./descriptors";

export type I5SettingsPanelProps = {
  readonly client: ConfigStoreClient;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
  readonly changes?: ConfigChangeSource;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
};

type SectionState = {
  readonly snapshot: ConfigSnapshot;
  readonly staged: StagedSettings;
  readonly validation: Readonly<Record<string, ValidationResult>>;
  readonly applyStatus?: string;
  readonly error?: string;
  readonly saving: boolean;
};

type SectionStates = Readonly<Record<string, SectionState>>;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function applyLabel(status: string): string {
  return status.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sectionStates(
  snapshots: readonly { descriptor: SettingsSectionDescriptor; snapshot: ConfigSnapshot }[],
): SectionStates {
  return Object.fromEntries(
    snapshots.map(({ descriptor, snapshot }) => {
      return [
        descriptor.id,
        {
          snapshot,
          staged: { snapshot, edits: {} },
          validation: {},
          saving: false,
        },
      ];
    }),
  );
}

export function I5SettingsPanel({
  client,
  folder,
  layer,
  changes,
  onSecretAction,
}: I5SettingsPanelProps) {
  const [states, setStates] = useState<SectionStates>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const snapshots = await Promise.all(
        I5_SETTINGS_SECTIONS.map(async (descriptor) => ({
          descriptor,
          snapshot: await readSection(client, descriptor, folder),
        })),
      );
      setStates(sectionStates(snapshots));
    } catch (error) {
      setLoadError(errorMessage(error, "The voice settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [client, folder]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!changes) return;
    const unsubscribers = I5_SETTINGS_SECTIONS.map((descriptor) =>
      subscribeChanged(changes, descriptor, () => {
        void load();
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [changes, load]);

  const stageSection = (descriptor: SettingsSectionDescriptor, staged: StagedSettings) => {
    setStates((current) => {
      const section = current[descriptor.id];
      if (!section) return current;
      return {
        ...current,
        [descriptor.id]: { ...section, staged, applyStatus: undefined, error: undefined },
      };
    });
  };

  const previewSection = (
    descriptor: SettingsSectionDescriptor,
    key: string,
    result: { readonly ok: true } | { readonly ok: false; readonly validation: ValidationResult },
  ) => {
    setStates((current) => {
      const section = current[descriptor.id];
      if (!section) return current;
      const validation = { ...section.validation };
      if (result.ok) delete validation[key];
      else validation[key] = result.validation;
      return { ...current, [descriptor.id]: { ...section, validation } };
    });
  };

  const cancelSection = (descriptor: SettingsSectionDescriptor) => {
    setStates((current) => {
      const section = current[descriptor.id];
      if (!section) return current;
      return {
        ...current,
        [descriptor.id]: {
          ...section,
          staged: { snapshot: section.snapshot, edits: {} },
          validation: {},
          applyStatus: undefined,
          error: undefined,
        },
      };
    });
  };

  const commitSection = async (descriptor: SettingsSectionDescriptor) => {
    const section = states[descriptor.id];
    if (!section || Object.keys(section.staged.edits).length === 0) return;
    setStates((current) => ({
      ...current,
      [descriptor.id]: { ...section, saving: true, error: undefined },
    }));
    try {
      const result = await commit(client, descriptor, section.staged, layer);
      const snapshot = await readSection(client, descriptor, folder);
      setStates((current) => ({
        ...current,
        [descriptor.id]: {
          snapshot,
          staged: { snapshot, edits: {} },
          validation: {},
          applyStatus: applyLabel(result.status),
          saving: false,
        },
      }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [descriptor.id]: {
          ...section,
          saving: false,
          error: errorMessage(error, "The settings could not be saved."),
        },
      }));
    }
  };

  return (
    <main className="bg-background text-foreground min-h-screen px-4 py-6 sm:px-8" data-i5-settings>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <p className="text-muted-foreground text-sm">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Voice and speech</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Speech input, realtime voice, playback and voice providers. Saved keys are never shown
            here.
          </p>
          <p className="text-muted-foreground text-xs" data-i5-settings-layer>
            {saveLocationText(layer)}
          </p>
        </header>
        {loading ? (
          <p className="text-muted-foreground rounded-lg border px-4 py-6 text-sm" role="status">
            Loading voice settings…
          </p>
        ) : loadError ? (
          <div
            className="border-destructive/50 bg-destructive/10 rounded-lg border px-4 py-4"
            role="alert"
          >
            <p className="text-destructive text-sm">{loadError}</p>
            <button
              type="button"
              className="border-input bg-background focus-visible:ring-ring mt-3 rounded-lg border px-3 py-1.5 text-sm focus-visible:ring-2"
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {I5_SETTINGS_SECTIONS.map((descriptor) => {
              const section = states[descriptor.id];
              if (!section) return null;
              return (
                <div key={descriptor.id} data-i5-settings-section={descriptor.id}>
                  <SettingsSection
                    descriptor={descriptor}
                    snapshot={section.snapshot}
                    staged={section.staged}
                    validation={section.validation}
                    disabled={section.saving}
                    applyStatus={section.applyStatus}
                    onStage={(next) => stageSection(descriptor, next)}
                    onPreview={(key, result) => previewSection(descriptor, key, result)}
                    onSecretAction={onSecretAction}
                    onCommit={() => void commitSection(descriptor)}
                    onCancel={() => cancelSection(descriptor)}
                  />
                  {section.error ? (
                    <p className="text-destructive mt-2 text-sm" role="alert">
                      {section.error}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
