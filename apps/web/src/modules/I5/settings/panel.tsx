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
import { commit, readSection, SettingsSection, subscribeChanged } from "../../S1/settings-kit";
import { I5_SETTINGS_SECTIONS, PROVIDERS_SERVICES_SECTION } from "./descriptors";

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
const PROVIDER_LIMITS_KEY = "providers.maxInFlightRequests";

type ProviderLimitRow = {
  readonly id: string;
  readonly provider: string;
  readonly limit: string;
};

let nextProviderRowId = 0;

type ProviderLimitResult =
  | { readonly ok: true; readonly value: Record<string, number> }
  | { readonly ok: false; readonly validation: ValidationResult };

function providerRows(
  snapshot: ConfigSnapshot,
  staged: StagedSettings,
): readonly ProviderLimitRow[] {
  const value =
    staged.edits[PROVIDER_LIMITS_KEY] ??
    snapshot.entries.find((entry) => entry.key === PROVIDER_LIMITS_KEY);
  if (
    !value ||
    value.secret ||
    typeof value.value !== "object" ||
    value.value === null ||
    Array.isArray(value.value)
  ) {
    return [];
  }
  return Object.entries(value.value)
    .filter(([, limit]) => typeof limit === "number")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, limit]) => ({ id: `provider-${provider}`, provider, limit: String(limit) }));
}

function providerLimitValue(
  rows: readonly ProviderLimitRow[],
  descriptor: SettingsSectionDescriptor,
  snapshot: ConfigSnapshot,
): ProviderLimitResult {
  const value: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const provider = row.provider.trim();
    const limit = Number(row.limit);
    if (!provider) {
      return {
        ok: false,
        validation: { valid: false, code: "provider", message: "Enter a provider name." },
      };
    }
    if (seen.has(provider)) {
      return {
        ok: false,
        validation: { valid: false, code: "provider", message: "Provider names must be unique." },
      };
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      return {
        ok: false,
        validation: { valid: false, code: "range", message: "Enter a positive request limit." },
      };
    }
    seen.add(provider);
    value[provider] = limit;
  }
  const control = descriptor.controls.find((candidate) => candidate.key === PROVIDER_LIMITS_KEY);
  const validation = control?.validate({ secret: false, value }, snapshot);
  return validation && !validation.valid ? { ok: false, validation } : { ok: true, value };
}

function ProviderLimitEditor({
  rows,
  disabled,
  validation,
  onChange,
  onAdd,
  onRemove,
}: {
  readonly rows: readonly ProviderLimitRow[];
  readonly disabled: boolean;
  readonly validation?: ValidationResult;
  readonly onChange: (index: number, field: "provider" | "limit", value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}) {
  return (
    <div className="border-border/60 border-b px-5 py-4" data-i5-provider-limits>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,1.25fr)] sm:items-start sm:gap-8">
        <div className="min-w-0">
          <div className="font-medium">Max In-Flight Requests</div>
          <p className="text-muted-foreground mt-1 text-sm">
            Limit concurrent requests by provider. Providers not listed here remain unlimited.
          </p>
        </div>
        <div className="min-w-0 space-y-2">
          {rows.map((row, index) => (
            <div className="flex min-w-0 items-center gap-2" key={row.id}>
              <input
                aria-label={`Provider name ${index + 1}`}
                className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2"
                disabled={disabled}
                placeholder="Provider name"
                value={row.provider}
                onChange={(event) => onChange(index, "provider", event.target.value)}
              />
              <input
                aria-label={`Request limit ${index + 1}`}
                className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring w-28 rounded-lg border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2"
                disabled={disabled}
                min="1"
                step="1"
                type="number"
                value={row.limit}
                onChange={(event) => onChange(index, "limit", event.target.value)}
              />
              <button
                type="button"
                aria-label={`Remove ${row.provider || `provider ${index + 1}`}`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-lg px-2 py-1.5 text-sm focus-visible:ring-2"
                disabled={disabled}
                onClick={() => onRemove(index)}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="border-input bg-background text-foreground focus-visible:ring-ring rounded-lg border px-3 py-1.5 text-sm focus-visible:ring-2"
              disabled={disabled}
              onClick={onAdd}
            >
              Add provider
            </button>
            {rows.length === 0 ? (
              <span className="text-muted-foreground text-xs">No provider-specific limits</span>
            ) : null}
          </div>
          {validation && !validation.valid ? (
            <p className="text-destructive text-sm" role="alert">
              {validation.message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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
  const [providerRowsBySection, setProviderRowsBySection] = useState<
    Readonly<Record<string, readonly ProviderLimitRow[]>>
  >({});
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
      const nextStates = sectionStates(snapshots);
      setStates(nextStates);
      const providerSection = nextStates[PROVIDERS_SERVICES_SECTION.id];
      setProviderRowsBySection(
        providerSection
          ? {
              [PROVIDERS_SERVICES_SECTION.id]: providerRows(
                providerSection.snapshot,
                providerSection.staged,
              ),
            }
          : {},
      );
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

  const updateProviderRows = (
    descriptor: SettingsSectionDescriptor,
    rows: readonly ProviderLimitRow[],
  ) => {
    setProviderRowsBySection((current) => ({ ...current, [descriptor.id]: rows }));
    setStates((current) => {
      const section = current[descriptor.id];
      if (!section) return current;
      const result = providerLimitValue(rows, descriptor, section.snapshot);
      const validation = { ...section.validation };
      if (!result.ok) {
        validation[PROVIDER_LIMITS_KEY] = result.validation;
        return { ...current, [descriptor.id]: { ...section, validation } };
      }
      delete validation[PROVIDER_LIMITS_KEY];
      return {
        ...current,
        [descriptor.id]: {
          ...section,
          staged: {
            ...section.staged,
            edits: {
              ...section.staged.edits,
              [PROVIDER_LIMITS_KEY]: { secret: false, value: result.value },
            },
          },
          validation,
          applyStatus: undefined,
          error: undefined,
        },
      };
    });
  };

  const addProviderRow = (descriptor: SettingsSectionDescriptor) => {
    const rows = providerRowsBySection[descriptor.id] ?? [];
    updateProviderRows(descriptor, [
      ...rows,
      { id: `new-provider-${nextProviderRowId++}`, provider: "", limit: "" },
    ]);
  };

  const removeProviderRow = (descriptor: SettingsSectionDescriptor, index: number) => {
    const rows = providerRowsBySection[descriptor.id] ?? [];
    updateProviderRows(
      descriptor,
      rows.filter((_, rowIndex) => rowIndex !== index),
    );
  };

  const changeProviderRow = (
    descriptor: SettingsSectionDescriptor,
    index: number,
    field: "provider" | "limit",
    value: string,
  ) => {
    const rows = [...(providerRowsBySection[descriptor.id] ?? [])];
    const row = rows[index];
    if (!row) return;
    rows[index] = { ...row, [field]: value };
    updateProviderRows(descriptor, rows);
  };

  const cancelSection = (descriptor: SettingsSectionDescriptor) => {
    const section = states[descriptor.id];
    if (section) {
      setProviderRowsBySection((current) => ({
        ...current,
        [descriptor.id]: providerRows(section.snapshot, { snapshot: section.snapshot, edits: {} }),
      }));
    }
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
      if (descriptor.id === PROVIDERS_SERVICES_SECTION.id) {
        setProviderRowsBySection((current) => ({
          ...current,
          [descriptor.id]: providerRows(snapshot, { snapshot, edits: {} }),
        }));
      }
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
            Speech input, realtime voice, playback, and provider services are read and written
            through omp&apos;s typed ConfigStore. Secret entries are write-only and never displayed
            here.
          </p>
          <p className="text-muted-foreground text-xs" data-i5-settings-layer>
            Layer: {layer} · Scope: {folder ?? "global"}
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
              const isProviderSection = descriptor.id === PROVIDERS_SERVICES_SECTION.id;
              const renderDescriptor = isProviderSection
                ? {
                    ...descriptor,
                    controls: descriptor.controls.filter(
                      (control) => control.key !== PROVIDER_LIMITS_KEY,
                    ),
                  }
                : descriptor;
              const settingsSection = (
                <SettingsSection
                  descriptor={renderDescriptor}
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
              );
              const sectionContent = isProviderSection ? (
                <div className="bg-card text-card-foreground overflow-hidden rounded-xl border shadow-sm">
                  <ProviderLimitEditor
                    rows={providerRowsBySection[descriptor.id] ?? []}
                    disabled={section.saving}
                    validation={section.validation[PROVIDER_LIMITS_KEY]}
                    onChange={(index, field, value) =>
                      changeProviderRow(descriptor, index, field, value)
                    }
                    onAdd={() => addProviderRow(descriptor)}
                    onRemove={(index) => removeProviderRow(descriptor, index)}
                  />
                  <div className="[&>section]:rounded-none [&>section]:border-0 [&>section]:shadow-none">
                    {settingsSection}
                  </div>
                </div>
              ) : (
                settingsSection
              );
              return (
                <div key={descriptor.id} data-i5-settings-section={descriptor.id}>
                  {sectionContent}
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
