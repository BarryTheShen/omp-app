import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  type ConfigChanged,
  type ConfigWriteLayer,
  type FolderPath,
  type JsonValue,
} from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, InlineError, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConflictChoice, SettingsRuntimeSnapshot } from "../../S1/runtime";
import {
  createConfigChangeSource,
  createConfigStoreClient,
  SettingsRuntime,
  useSettingsRuntime,
} from "../../S1/runtime";
import type {
  ApplyStatus,
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  PreviewResult,
  ScalarSettingControl,
  SettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  StagedSettings,
  ValidationResult,
} from "../../S1/settings-kit";
import {
  effectiveEntry,
  provenanceLabel,
  readSection,
  SettingsSection,
  saveLocationText,
  settingLabels,
  UnsavedSettingsNotice,
} from "../../S1/settings-kit";
import {
  DEFAULT_COMPACTION_METHOD_ORDER,
  P7_CONTEXT_NUMERIC_SETTINGS,
  P7_CONTEXT_SETTINGS_SECTIONS,
} from "./descriptors";

export type ContextSettingsScope =
  | { readonly layer: "global"; readonly folder?: null }
  | { readonly layer: "project"; readonly folder: FolderPath };

export type ContextSettingsProps = {
  readonly client: AppClient;
  readonly scope: ContextSettingsScope;
  /** The live Settings screen draws its own page header, so it can turn this one off. */
  readonly showHeader?: boolean;
  /** Told whenever a section has staged edits that are not saved, so the screen can ask before a switch. */
  readonly onDirtyChange?: (dirty: boolean) => void;
};

type ContextSettingsRuntimeSection = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly runtime: SettingsRuntime;
};

type ContextSettingsRuntimeSet = {
  readonly client: AppClient;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
  readonly sections: readonly ContextSettingsRuntimeSection[];
};

/** What the page needs to know about all of its sections together. */
type ContextSettingsStatus = {
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly loadError: AppError | null;
};

type ContextSettingsModel = {
  readonly layer: ConfigWriteLayer;
  readonly sections: readonly ContextSettingsRuntimeSection[];
  readonly status: ContextSettingsStatus;
  readonly retryLoad: () => void;
  readonly save: (runtime: SettingsRuntime) => void;
};

/** The Context tab's persisted omp settings, read and written only through A1 ConfigStore. */
export function ContextSettings({
  client,
  scope,
  showHeader = true,
  onDirtyChange,
}: ContextSettingsProps) {
  const model = useContextSettingsController(client, scope);
  useDirtyReport(model.status.dirty, onDirtyChange);
  return <ContextSettingsView model={model} showHeader={showHeader} />;
}

/**
 * Tells the owner whether any section has unsaved edits. Unmounting reports false, so an owner never
 * keeps a "still unsaved" flag for a view that has gone.
 */
function useDirtyReport(dirty: boolean, onDirtyChange: ((dirty: boolean) => void) | undefined) {
  const latest = useRef(onDirtyChange);
  useEffect(() => {
    latest.current = onDirtyChange;
  });
  useEffect(() => {
    latest.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => latest.current?.(false), []);
}

function useContextSettingsController(
  client: AppClient,
  scope: ContextSettingsScope,
): ContextSettingsModel {
  const folder = scope.layer === "project" ? scope.folder : null;
  const layer: ConfigWriteLayer = scope.layer;
  const [runtimeSet, setRuntimeSet] = useState<ContextSettingsRuntimeSet | null>(null);

  useEffect(() => {
    const sections = P7_CONTEXT_SETTINGS_SECTIONS.map((descriptor) => ({
      descriptor,
      runtime: createSectionRuntime(client, descriptor, folder, layer),
    }));
    setRuntimeSet({ client, folder, layer, sections });
    for (const section of sections) void readContextSection(section.runtime);
    return () => {
      for (const section of sections) section.runtime.dispose();
    };
  }, [client, folder, layer]);

  const sections =
    runtimeSet?.client === client && runtimeSet.folder === folder && runtimeSet.layer === layer
      ? runtimeSet.sections
      : [];
  const status = useSectionsStatus(sections);
  const configClient = useMemo(() => createConfigStoreClient(client), [client]);
  const retryLoad = useCallback(() => {
    for (const section of sections) {
      const state = section.runtime.getSnapshot();
      if (state.config === null && state.phase === "error") {
        void readContextSection(section.runtime);
      }
    }
  }, [sections]);
  const save = useCallback(
    (runtime: SettingsRuntime) => {
      void saveContextSection(sections, configClient, runtime);
    },
    [sections, configClient],
  );
  return { layer, sections, status, retryLoad, save };
}

/**
 * One section's runtime. An outside change reaches the section only when it touches a key the section has
 * staged. Any other change re-bases the section onto the file and keeps its staged edits, which is not a conflict.
 */
function createSectionRuntime(
  client: AppClient,
  descriptor: SettingsSectionDescriptor,
  folder: FolderPath | null,
  layer: ConfigWriteLayer,
): SettingsRuntime {
  const configClient = createConfigStoreClient(client);
  let runtime: SettingsRuntime | undefined;
  const changes = createConfigChangeSource(client, folder, (error) => runtime?.fail(error));
  const source: ConfigChangeSource = {
    subscribe(listener) {
      return changes.subscribe((change) => {
        if (runtime === undefined || !hasStagedEdits(runtime.getSnapshot())) {
          listener(change);
          return;
        }
        void forwardStagedChange(runtime, configClient, change, listener);
      });
    },
  };
  runtime = new SettingsRuntime(configClient, source, { descriptor, folder, layer });
  return runtime;
}

/** Passes a change on to the runtime, unless it only re-bases a section whose staged keys did not change. */
async function forwardStagedChange(
  runtime: SettingsRuntime,
  client: ConfigStoreClient,
  change: ConfigChanged,
  listener: (change: ConfigChanged) => void,
): Promise<void> {
  try {
    if ((await rebaseStagedSection(runtime, client)) !== "rebased") listener(change);
  } catch (error: unknown) {
    reportRuntimeFailure(runtime, error, "Loading context settings failed.");
  }
}

type RebaseOutcome = "rebased" | "changed" | "skipped";

/**
 * Re-bases a section that has staged edits onto the file as it is now, when none of its staged keys changed in
 * the file. The edits stay staged. When a staged key did change, nothing is re-based: the section's next save
 * reports the conflict, so nothing is overwritten.
 */
async function rebaseStagedSection(
  runtime: SettingsRuntime,
  client: ConfigStoreClient,
): Promise<RebaseOutcome> {
  const before = runtime.getSnapshot();
  if (!before.staged || !hasStagedEdits(before)) return "skipped";
  if ((before.phase !== "ready" && before.phase !== "editing") || before.conflict !== null) {
    return "skipped";
  }
  const base = before.staged.snapshot;
  const remote = await readSection(client, before.descriptor, before.folder);
  const now = runtime.getSnapshot();
  if (!now.staged || now.staged.snapshot !== base) return "skipped";
  if ((now.phase !== "ready" && now.phase !== "editing") || now.conflict !== null) return "skipped";
  const edits = now.staged.edits;
  if (changedStagedKeys(base, remote, edits).length > 0) return "changed";
  const fresh = await runtime.read();
  if (runtime.getSnapshot().staged?.snapshot !== fresh) return "skipped";
  if (changedStagedKeys(base, fresh, edits).length > 0) {
    // The file changed between the two reads, after the check above. The edits cannot be kept on the file
    // they were made against, so they are not staged on the new one; the person is told and enters them again.
    runtime.fail(
      new AppFailure({
        code: "conflict",
        message:
          "A setting you had changed here was changed elsewhere while this section was updating. Your change was not kept; enter it again.",
        retryable: true,
      }),
    );
    return "changed";
  }
  for (const [key, value] of Object.entries(edits)) runtime.stage(key, value);
  return "rebased";
}

/** The staged keys whose stored value differs between `base` and `remote`. */
function changedStagedKeys(
  base: ConfigSnapshot,
  remote: ConfigSnapshot,
  edits: StagedSettings["edits"],
): readonly string[] {
  const changed: string[] = [];
  for (const key of Object.keys(edits)) {
    if (storedText(base, key) !== storedText(remote, key)) changed.push(key);
  }
  return changed;
}

/** A key's stored value as text, so two snapshots compare by value. */
function storedText(snapshot: ConfigSnapshot, key: string): string {
  const entry = effectiveEntry(snapshot, key);
  if (entry === undefined) return "";
  return entry.secret ? `secret:${String(entry.isSet)}` : JSON.stringify(entry.value);
}

function hasStagedEdits(state: SettingsRuntimeSnapshot): boolean {
  return state.staged !== null && Object.keys(state.staged.edits).length > 0;
}

/** Reads one section. A failure stays on its runtime, and the page shows it once with one Retry. */
function readContextSection(runtime: SettingsRuntime): Promise<void> {
  return runtime.read().then(
    () => undefined,
    (error: unknown) => reportRuntimeFailure(runtime, error, "Loading context settings failed."),
  );
}

/**
 * Saves one section, then brings every other section up to date with the file (see refreshSection). The save
 * may have written some keys even when it failed, so the others are refreshed either way.
 */
async function saveContextSection(
  sections: readonly ContextSettingsRuntimeSection[],
  client: ConfigStoreClient,
  runtime: SettingsRuntime,
): Promise<void> {
  if (Object.values(runtime.getSnapshot().validation).some((result) => !result.valid)) return;
  try {
    await runtime.save();
  } catch (error: unknown) {
    // The runtime records a failed save itself: its error, the keys still unsaved, or a conflict. Only a
    // failure it could not record is reported here.
    if (runtime.getSnapshot().error === null) {
      reportRuntimeFailure(runtime, error, "Saving context settings failed.");
    }
  } finally {
    await Promise.all(
      sections
        .filter((section) => section.runtime !== runtime)
        .map((section) => refreshSection(section.runtime, client)),
    );
  }
}

/**
 * Brings one section up to date after another section saved. A section with nothing staged is re-read. A section
 * with staged edits keeps them when none of its staged keys changed in the file; otherwise its own save reports
 * the conflict.
 */
async function refreshSection(runtime: SettingsRuntime, client: ConfigStoreClient): Promise<void> {
  if (!hasStagedEdits(runtime.getSnapshot())) {
    await readContextSection(runtime);
    return;
  }
  try {
    await rebaseStagedSection(runtime, client);
  } catch (error: unknown) {
    reportRuntimeFailure(runtime, error, "Loading context settings failed.");
  }
}

function useSectionsStatus(
  sections: readonly ContextSettingsRuntimeSection[],
): ContextSettingsStatus {
  const [status, setStatus] = useState(() => sectionsStatus(sections));
  useEffect(() => {
    const update = () => setStatus(sectionsStatus(sections));
    const stops = sections.map((section) => section.runtime.subscribe(update));
    update();
    return () => {
      for (const stop of stops) stop();
    };
  }, [sections]);
  return status;
}

function sectionsStatus(sections: readonly ContextSettingsRuntimeSection[]): ContextSettingsStatus {
  let dirty = false;
  let pending = sections.length === 0;
  let loadError: AppError | null = null;
  for (const section of sections) {
    const state = section.runtime.getSnapshot();
    if (hasStagedEdits(state)) dirty = true;
    if (state.config !== null) continue;
    if (state.phase === "error" && state.error !== null) {
      loadError = loadError ?? state.error;
    } else {
      pending = true;
    }
  }
  return { dirty, loading: pending && loadError === null, loadError };
}

/** Whether a section matches the search: its title, or a control's label or description. */
function sectionMatches(descriptor: SettingsSectionDescriptor, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  const searchable = [
    descriptor.title,
    ...descriptor.controls.flatMap((control) => [control.label, control.description ?? ""]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(needle);
}

/**
 * The Context tab, laid out like the Appearance tab: a search box, one chip per section, and one section at a
 * time. Each section keeps its staged edits while another is open, because its runtime lives in the controller.
 */
function ContextSettingsView({
  model,
  showHeader,
}: {
  readonly model: ContextSettingsModel;
  readonly showHeader: boolean;
}) {
  const { status } = model;
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const shown = useMemo(
    () => model.sections.filter((section) => sectionMatches(section.descriptor, query)),
    [model.sections, query],
  );
  const active = shown.find((section) => section.descriptor.id === chosenId) ?? shown[0];
  return (
    <div
      className={showHeader ? "bg-background text-foreground space-y-4 p-4 sm:p-6" : "space-y-4"}
      data-p7-context-settings
    >
      {showHeader ? (
        <header className="space-y-1">
          <p className="text-muted-foreground text-sm">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Context</h1>
          <p className="text-muted-foreground text-sm">
            Context windows, compaction, and rules for omp.
          </p>
          <p className="text-muted-foreground text-xs">{saveLocationText(model.layer)}</p>
        </header>
      ) : null}
      <div className="space-y-3">
        <label className="text-sm font-medium" htmlFor="p7-context-search">
          Search settings
        </label>
        <Input
          id="p7-context-search"
          type="search"
          value={query}
          placeholder="Search context settings"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {status.loadError ? (
        <InlineError
          heading="Context settings could not be loaded"
          message={status.loadError.message}
          onRetry={model.retryLoad}
        />
      ) : null}
      {status.loading ? <EmptyState title="Loading context settings…" variant="compact" /> : null}
      {!status.loading && shown.length === 0 ? (
        <EmptyState title="No settings match this search." variant="compact" />
      ) : null}
      {!status.loading && shown.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2" aria-label="Context sections" role="tablist">
            {shown.map((section) => {
              const id = section.descriptor.id;
              const selected = id === active?.descriptor.id;
              return (
                <Button
                  key={id}
                  id={`p7-context-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-controls={`p7-context-panel-${id}`}
                  aria-selected={selected}
                  variant={selected ? "default" : "outline"}
                  onClick={() => setChosenId(id)}
                >
                  {section.descriptor.title}
                </Button>
              );
            })}
          </div>
          {active ? (
            <div
              id={`p7-context-panel-${active.descriptor.id}`}
              role="tabpanel"
              aria-labelledby={`p7-context-tab-${active.descriptor.id}`}
            >
              <ContextSettingsSectionController
                key={active.descriptor.id}
                descriptor={active.descriptor}
                onSave={model.save}
                runtime={active.runtime}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type ContextSettingsSectionActions = {
  readonly onStage: (staged: StagedSettings) => void;
  readonly onPreview: (key: string, result: PreviewResult) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly onConflictChoice: (choice: ConflictChoice) => void;
  readonly onCustomStage: (key: string, value: SettingValue) => void;
};

function ContextSettingsSectionController({
  descriptor,
  onSave,
  runtime,
}: {
  readonly descriptor: SettingsSectionDescriptor;
  readonly onSave: (runtime: SettingsRuntime) => void;
  readonly runtime: SettingsRuntime;
}) {
  const state = useSettingsRuntime(runtime);
  const [resetToken, setResetToken] = useState(0);
  const [scalarValidation, setScalarValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});
  const config = state.config;
  const viewDescriptor = useMemo(
    () =>
      config
        ? {
            ...descriptor,
            // Lists are drawn inside the card, after the rows. A menu shows the value omp has stored, and a
            // stored value that omp ignores says so on its row.
            controls: descriptor.controls
              .filter((control) => control.kind !== "list")
              .map((control) => withStoredState(control, config)),
          }
        : null,
    [descriptor, config],
  );

  useEffect(() => {
    if (state.phase === "ready" && state.staged && Object.keys(state.staged.edits).length === 0) {
      setScalarValidation({});
    }
  }, [state.phase, state.staged]);

  if (config === null || viewDescriptor === null) return null;
  const customControls = descriptor.controls.filter(
    (control): control is ScalarSettingControl => control.kind === "list",
  );
  const disabled =
    state.phase === "idle" ||
    state.phase === "loading" ||
    state.phase === "saving" ||
    state.phase === "conflict" ||
    state.conflict !== null;
  const actions: ContextSettingsSectionActions = {
    onStage: (next) => stageVisibleControls(runtime, viewDescriptor, next),
    onPreview: (key, result) => {
      if (!result.ok) {
        setScalarValidation((current) => ({ ...current, [key]: result.validation }));
        return;
      }
      setScalarValidation((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    onCommit: () => onSave(runtime),
    onCancel: () => {
      runtime.cancel();
      setScalarValidation({});
      setResetToken((token) => token + 1);
    },
    onConflictChoice: (choice) => {
      runtime.resolveConflict(choice);
      if (choice === "reload") {
        setScalarValidation({});
        setResetToken((token) => token + 1);
      }
    },
    onCustomStage: (key, value) => {
      runtime.stage(key, value);
    },
  };

  return (
    <ContextSettingsSectionView
      actions={actions}
      applyStatus={state.applyStatus ? applyStatusLabel(state.applyStatus) : undefined}
      customControls={customControls}
      descriptor={descriptor}
      disabled={disabled}
      resetToken={resetToken}
      state={state}
      validation={{ ...state.validation, ...scalarValidation }}
      viewDescriptor={viewDescriptor}
    />
  );
}

function ContextSettingsSectionView({
  actions,
  applyStatus,
  customControls,
  descriptor,
  disabled,
  resetToken,
  state,
  validation,
  viewDescriptor,
}: {
  readonly actions: ContextSettingsSectionActions;
  readonly applyStatus: string | undefined;
  readonly customControls: readonly ScalarSettingControl[];
  readonly descriptor: SettingsSectionDescriptor;
  readonly disabled: boolean;
  readonly resetToken: number;
  readonly state: SettingsRuntimeSnapshot;
  readonly validation: Readonly<Record<string, ValidationResult>>;
  readonly viewDescriptor: SettingsSectionDescriptor;
}) {
  const config = state.config;
  const staged = state.staged;
  if (!config || !staged) return null;
  const unsavedLabels = settingLabels(descriptor, state.unsavedKeys);

  return (
    <div className="space-y-3" data-p7-context-section={descriptor.id}>
      <SettingsSection
        key={`${descriptor.id}-${config.revision}-${resetToken}`}
        descriptor={viewDescriptor}
        snapshot={config}
        staged={staged}
        validation={validation}
        disabled={disabled}
        applyStatus={applyStatus}
        unsavedKeys={state.unsavedKeys}
        listControls={customControls.map((control) => (
          <CustomListSetting
            key={`${control.key}-${resetToken}`}
            control={control}
            snapshot={config}
            staged={staged}
            validation={state.validation[control.key]}
            disabled={disabled}
            onStage={(value) => actions.onCustomStage(control.key, value)}
          />
        ))}
        onStage={actions.onStage}
        onPreview={actions.onPreview}
        onCommit={actions.onCommit}
        onCancel={actions.onCancel}
      />
      {state.conflict ? (
        <div role="alert">
          <Section
            description="Another change arrived while this section was open. Reload the latest values or keep your edits and save again."
            heading="Settings changed elsewhere"
            headingLevel={3}
          >
            <Toolbar ariaLabel="Conflict actions" alignment="start">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.onConflictChoice("reload")}
              >
                Reload latest
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.onConflictChoice("keep-mine")}
              >
                Keep my edits
              </Button>
            </Toolbar>
          </Section>
        </div>
      ) : unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice labels={unsavedLabels} reason={state.error?.message ?? ""} />
      ) : state.error ? (
        <InlineError message={state.error.message} variant="compact" />
      ) : null}
    </div>
  );
}

function CustomListSetting({
  control,
  snapshot,
  staged,
  validation,
  disabled,
  onStage,
}: {
  readonly control: ScalarSettingControl;
  readonly snapshot: ConfigSnapshot;
  readonly staged: StagedSettings;
  readonly validation: ValidationResult | undefined;
  readonly disabled: boolean;
  readonly onStage: (value: SettingValue) => void;
}) {
  if (control.key === "compaction.methodOrder") {
    return (
      <CompactionMethodOrderSetting
        control={control}
        snapshot={snapshot}
        staged={staged}
        validation={validation}
        disabled={disabled}
        onStage={onStage}
      />
    );
  }
  return (
    <TextListSetting
      control={control}
      snapshot={snapshot}
      staged={staged}
      validation={validation}
      disabled={disabled}
      onStage={onStage}
    />
  );
}

function CompactionMethodOrderSetting({
  control,
  snapshot,
  staged,
  validation,
  disabled,
  onStage,
}: {
  readonly control: ScalarSettingControl;
  readonly snapshot: ConfigSnapshot;
  readonly staged: StagedSettings;
  readonly validation: ValidationResult | undefined;
  readonly disabled: boolean;
  readonly onStage: (value: SettingValue) => void;
}) {
  const current = settingValue(snapshot, staged, control);
  const values = current.secret ? null : readStringList(current.value);
  const methods = values ?? DEFAULT_COMPACTION_METHOD_ORDER;
  const availableOptions = (control.options ?? []).filter(
    (option): option is SettingOption & { readonly value: string } =>
      typeof option.value === "string",
  );
  const currentValidation = validation ?? control.validate(current, snapshot);

  const selectMethod = (index: number, selected: string) => {
    const existingIndex = methods.indexOf(selected);
    const next = [...methods];
    const original = next[index];
    if (original === undefined) return;
    next[index] = selected;
    if (existingIndex >= 0 && existingIndex !== index) next[existingIndex] = original;
    onStage({ secret: false, value: next });
  };
  const moveMethod = (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset;
    const currentMethod = methods[index];
    const targetMethod = methods[targetIndex];
    if (currentMethod === undefined || targetMethod === undefined) return;
    const next = [...methods];
    next[index] = targetMethod;
    next[targetIndex] = currentMethod;
    onStage({ secret: false, value: next });
  };
  const addMethod = () => {
    const option = availableOptions.find((candidate) => !methods.includes(candidate.value));
    if (!option) return;
    onStage({ secret: false, value: [...methods, option.value] });
  };
  const removeMethod = (index: number) => {
    if (methods.length <= 1) return;
    onStage({ secret: false, value: methods.filter((_, itemIndex) => itemIndex !== index) });
  };

  return (
    <SettingRow
      title={control.label}
      description={control.description}
      detail={<span>Source: {sourceFor(snapshot, control.key)}</span>}
    >
      <div className="space-y-2">
        {methods.map((method, index) => {
          const option = availableOptions.find((candidate) => candidate.value === method);
          const label = option?.label ?? "Unsupported method";
          return (
            <div className="flex flex-wrap items-center gap-2" key={method}>
              <label className="sr-only" htmlFor={`p7-method-${index}`}>
                Method {index + 1}
              </label>
              <select
                className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 min-w-0 flex-1 basis-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2 md:basis-auto md:min-w-40"
                id={`p7-method-${index}`}
                value={method}
                disabled={disabled}
                onChange={(event) => selectMethod(index, event.target.value)}
              >
                {!option ? <option value={method}>Unsupported method</option> : null}
                {availableOptions.map((candidate) => (
                  <option key={candidate.value} value={candidate.value}>
                    {candidate.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Move up, ${label}`}
                onClick={() => moveMethod(index, -1)}
                disabled={disabled || index === 0}
              >
                Move up
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Move down, ${label}`}
                onClick={() => moveMethod(index, 1)}
                disabled={disabled || index === methods.length - 1}
              >
                Move down
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove ${label}`}
                onClick={() => removeMethod(index)}
                disabled={disabled || methods.length === 1}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={addMethod}
            disabled={disabled || methods.length >= availableOptions.length}
          >
            Add method
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-8 max-w-full shrink whitespace-normal py-1"
            onClick={() => onStage({ secret: false, value: [...DEFAULT_COMPACTION_METHOD_ORDER] })}
            disabled={disabled}
          >
            Use omp's default order
          </Button>
        </div>
        {!currentValidation.valid ? (
          <InlineError message={currentValidation.message} variant="message" />
        ) : null}
      </div>
    </SettingRow>
  );
}

function TextListSetting({
  control,
  snapshot,
  staged,
  validation,
  disabled,
  onStage,
}: {
  readonly control: ScalarSettingControl;
  readonly snapshot: ConfigSnapshot;
  readonly staged: StagedSettings;
  readonly validation: ValidationResult | undefined;
  readonly disabled: boolean;
  readonly onStage: (value: SettingValue) => void;
}) {
  const current = settingValue(snapshot, staged, control);
  const values = current.secret ? null : readStringList(current.value);
  const currentText = values?.join("\n") ?? "";
  const [draft, setDraft] = useState(currentText);
  const currentValidation = validation ?? control.validate(current, snapshot);

  useEffect(() => {
    setDraft(currentText);
  }, [currentText]);

  return (
    <SettingRow
      title={control.label}
      description={control.description}
      detail={<span>Source: {sourceFor(snapshot, control.key)}</span>}
    >
      <Textarea
        aria-label={control.label}
        className="text-foreground"
        style={{ color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" }}
        rows={3}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          const nextValues = nextDraft
            .split(/\r?\n/u)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          onStage({ secret: false, value: nextValues });
        }}
      />
      <p className="text-muted-foreground text-xs">One entry per line. Blank lines are ignored.</p>
      {!currentValidation.valid ? (
        <InlineError message={currentValidation.message} variant="message" />
      ) : null}
    </SettingRow>
  );
}

function sourceFor(snapshot: ConfigSnapshot, key: string): string {
  const entry = effectiveEntry(snapshot, key);
  if (!entry) return "Not configured";
  return provenanceLabel(entry);
}

function stageVisibleControls(
  runtime: SettingsRuntime,
  descriptor: SettingsSectionDescriptor,
  staged: StagedSettings,
): void {
  const existing = runtime.getSnapshot().staged?.edits ?? {};
  for (const control of descriptor.controls) {
    const value = staged.edits[control.key];
    if (!value || sameSettingValue(existing[control.key], value)) continue;
    runtime.stage(control.key, normalizeSettingValue(control, value));
  }
}

function normalizeSettingValue(control: SettingControl, value: SettingValue): SettingValue {
  if (
    control.kind === "enum" &&
    P7_CONTEXT_NUMERIC_SETTINGS.includes(control.key) &&
    !value.secret &&
    typeof value.value === "string"
  ) {
    return { secret: false, value: Number(value.value) };
  }
  return value;
}

function sameSettingValue(
  left: SettingValue | undefined,
  right: SettingValue | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

type StoredValue = { readonly secret: false; readonly value: JsonValue };

/** The value omp has stored for a key, or null when the key is not set (omp then uses its default). */
function storedValue(config: ConfigSnapshot, key: string): StoredValue | null {
  const entry = effectiveEntry(config, key);
  return entry && !entry.secret ? { secret: false, value: entry.value } : null;
}

function withStoredState(control: SettingControl, config: ConfigSnapshot): SettingControl {
  if (control.kind === "map" || control.kind === "rows") return control;
  const stored = storedValue(config, control.key);
  const ignored = stored !== null && isIgnoredByOmp(control, stored, config);
  const note = "omp ignores this saved value and uses the default.";
  const described: ScalarSettingControl =
    ignored && stored
      ? { ...control, description: control.description ? `${control.description} ${note}` : note }
      : control;
  return control.kind === "enum" ? withStoredChoice(described, stored) : described;
}

/** omp keeps a stored value only when it is the right kind for the setting; any other value falls back to the default. */
function isIgnoredByOmp(
  control: ScalarSettingControl,
  stored: StoredValue,
  config: ConfigSnapshot,
): boolean {
  if (!control.validate(stored, config).valid) return true;
  return P7_CONTEXT_NUMERIC_SETTINGS.includes(control.key) && typeof stored.value === "string";
}

/**
 * omp registers some choices as plain numbers, so a saved value can sit off the menu. It is shown as its own
 * choice, so the menu never shows the wrong one, and Save is not blocked by it.
 */
function withStoredChoice(
  control: ScalarSettingControl,
  stored: StoredValue | null,
): ScalarSettingControl {
  if (stored === null || !control.options) return control;
  const value = stored.value;
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
    return control;
  }
  const text = String(value);
  if (control.options.some((option) => option.value === text)) return control;
  const label =
    typeof value === "number" ? `${text} (current)` : "Saved value, not one omp uses (current)";
  return { ...control, options: [{ value: text, label }, ...control.options] };
}

function settingValue(
  snapshot: ConfigSnapshot,
  staged: StagedSettings,
  control: ScalarSettingControl,
): SettingValue {
  const edit = staged.edits[control.key];
  if (edit) return edit;
  const entry = effectiveEntry(snapshot, control.key);
  if (entry)
    return entry.secret ? { secret: true, action: "unset" } : { secret: false, value: entry.value };
  return {
    secret: false,
    value: control.key === "compaction.methodOrder" ? [...DEFAULT_COMPACTION_METHOD_ORDER] : [],
  };
}

function readStringList(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    return null;
  return value;
}

/** The same words the live Settings screen uses for an apply boundary. */
function applyStatusLabel(status: ApplyStatus): string {
  switch (status) {
    case "applied":
      return "Applied";
    case "session-only":
      return "This session only";
    case "reload-required":
      return "Reload required";
    case "restart-required":
      return "Restart required";
    case "unsupported":
      return "Unavailable";
  }
}

function reportRuntimeFailure(runtime: SettingsRuntime, error: unknown, fallback: string): void {
  if (error instanceof AppFailure) {
    runtime.fail(error);
    return;
  }
  runtime.fail(
    new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error }),
  );
}
