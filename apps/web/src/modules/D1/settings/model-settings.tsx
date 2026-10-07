import type { ConfigSource } from "@omp-app/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  settingSourceLabel,
} from "@/modules/S1/settings-kit";
import { type SettingsRuntime, useSettingsRuntime } from "../../S1/runtime";
import type { ModelRef } from "../contract";
export type ModelPresetController = {
  readonly presets: readonly string[];
  readonly save: (name: string) => Promise<void>;
  readonly switch: (name: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
};

export type ModelSettingsSectionProps = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly runtime: SettingsRuntime;
};

export type ModelSettingsSurfaceProps = {
  readonly sections: readonly ModelSettingsSectionProps[];
  readonly sessionModel: ModelRef | null;
  readonly defaultModel: ModelRef | null;
  readonly defaultSource: ConfigSource;
  readonly presets?: ModelPresetController;
};

function phaseLabel(
  phase: ReturnType<SettingsRuntime["getSnapshot"]>["phase"],
): string | undefined {
  switch (phase) {
    case "loading":
      return "Loading settings…";
    case "saving":
      return "Saving…";
    case "conflict":
      return "Conflict — choose how to continue";
    case "error":
      return "Settings unavailable";
    default:
      return undefined;
  }
}

function changedEdits(
  before: StagedSettings | null,
  after: StagedSettings,
): readonly [string, StagedSettings["edits"][string]][] {
  const previous = before?.edits ?? {};
  return Object.entries(after.edits).filter(
    ([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
  );
}

export function ModelSettingsSection({ descriptor, runtime }: ModelSettingsSectionProps) {
  const snapshot = useSettingsRuntime(runtime);
  useEffect(() => {
    if (snapshot.phase === "idle") void runtime.read().catch(() => undefined);
  }, [runtime, snapshot.phase]);

  const config = snapshot.config;
  if (!config || !snapshot.staged) {
    return (
      <section
        aria-labelledby={`${descriptor.id}-loading-title`}
        className="flex min-h-40 flex-col gap-3 rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
      >
        <h2 id={`${descriptor.id}-loading-title`} className="text-lg font-semibold tracking-tight">
          {descriptor.title}
        </h2>
        <p
          role={snapshot.phase === "error" ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {snapshot.error?.message ?? phaseLabel(snapshot.phase) ?? "Preparing settings…"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void runtime.retry().catch(() => undefined)}
        >
          Retry
        </Button>
      </section>
    );
  }

  const staged = snapshot.staged;
  const apply = () => void runtime.save().catch(() => undefined);
  const onStage = (next: StagedSettings) => {
    for (const [key, value] of changedEdits(staged, next)) runtime.stage(key, value);
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={`model-settings-${descriptor.title.toLowerCase().replaceAll(" ", "-")}`}
    >
      <SettingsSection
        descriptor={descriptor}
        snapshot={config}
        staged={staged}
        validation={snapshot.validation}
        applyStatus={
          snapshot.applyStatus ? applyStatusLabel(snapshot.applyStatus) : phaseLabel(snapshot.phase)
        }
        onStage={onStage}
        onCommit={apply}
        onCancel={() => runtime.cancel()}
      />
      {snapshot.phase === "conflict" && snapshot.conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          <span className="text-warning-foreground">
            Another change arrived for {snapshot.conflict.changedKeys.join(", ")}. Reload it or keep
            your edits and save again.
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runtime.resolveConflict("reload")}
            >
              Reload
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runtime.resolveConflict("keep-mine")}
            >
              Keep mine
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function applyStatusLabel(
  status: NonNullable<ReturnType<SettingsRuntime["getSnapshot"]>["applyStatus"]>,
): string {
  switch (status) {
    case "session-only":
      return "Session only";
    case "reload-required":
      return "Reload required";
    case "restart-required":
      return "Restart required";
    case "unsupported":
      return "Unsupported";
    default:
      return "Applied";
  }
}

function modelLabel(model: ModelRef | null): string {
  return model ? `${model.provider}/${model.modelId}` : "Not available";
}

export function ModelScopeSummary({
  sessionModel,
  defaultModel,
  defaultSource,
}: Pick<ModelSettingsSurfaceProps, "sessionModel" | "defaultModel" | "defaultSource">) {
  return (
    <section
      aria-labelledby="model-scope-summary-title"
      className="rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
    >
      <h2 id="model-scope-summary-title" className="text-base font-semibold">
        Model scope
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The active session model and saved default are independent choices.
      </p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <dt className="text-xs text-muted-foreground">This session</dt>
          <dd data-testid="session-model" className="mt-1 font-medium">
            {modelLabel(sessionModel)}
          </dd>
          <p className="mt-1 text-xs text-muted-foreground">
            Changes future prompts without writing the saved default.
          </p>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Saved default</dt>
          <dd data-testid="default-model" className="mt-1 font-medium">
            {modelLabel(defaultModel)}
          </dd>
          <p data-testid="default-model-source" className="mt-1 text-xs text-muted-foreground">
            Source: {settingSourceLabel(defaultSource)}
          </p>
        </div>
      </dl>
    </section>
  );
}

export function ModelPresetControls({ presets }: { readonly presets: ModelPresetController }) {
  const [name, setName] = useState("balanced");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The preset operation failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="model-presets-title"
      className="rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
    >
      <h2 id="model-presets-title" className="text-base font-semibold">
        Saved presets
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Save and switch role maps through A1.4 with CAS protection.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label htmlFor="model-preset-name" className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">Preset name</span>
          <Input
            id="model-preset-name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => presets.save(name))}
        >
          Save preset
        </Button>
      </div>
      <section aria-label="Saved preset list" className="mt-3 flex flex-col gap-2">
        {presets.presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved presets.</p>
        ) : null}
        {presets.presets.map((preset) => (
          <div
            key={preset}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm"
          >
            <span>{preset}</span>
            <span className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => presets.switch(preset))}
              >
                Switch
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => presets.remove(preset))}
              >
                Delete
              </Button>
            </span>
          </div>
        ))}
      </section>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ModelSettingsSurface({
  sections,
  sessionModel,
  defaultModel,
  defaultSource,
  presets,
}: ModelSettingsSurfaceProps) {
  const sectionList = useMemo(() => sections, [sections]);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Model settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Persisted model policy and the current session routing are shown separately.
          </p>
        </header>
        <ModelScopeSummary
          sessionModel={sessionModel}
          defaultModel={defaultModel}
          defaultSource={defaultSource}
        />
        {presets ? <ModelPresetControls presets={presets} /> : null}
        <div className="grid gap-5 lg:grid-cols-2">
          {sectionList.map(({ descriptor, runtime }) => (
            <ModelSettingsSection key={descriptor.id} descriptor={descriptor} runtime={runtime} />
          ))}
        </div>
      </div>
    </main>
  );
}
