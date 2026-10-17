import { useEffect } from "react";
import { ConflictBanner, InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import {
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  environmentOverrideText,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  settingLabels,
  settingsConflictRows,
  UnsavedSettingsNotice,
} from "@/modules/S1/settings-kit";
import { type SettingsRuntime, useSettingsRuntime } from "../../S1/runtime";

export type ModelSettingsSectionProps = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly runtime: SettingsRuntime;
};

function phaseLabel(
  phase: ReturnType<SettingsRuntime["getSnapshot"]>["phase"],
): string | undefined {
  switch (phase) {
    case "loading":
      return "Loading settings…";
    case "saving":
      return "Saving…";
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
  // A failed save is recorded in the runtime's snapshot (its error and unsaved keys), which is shown below.
  const apply = () => void runtime.save().catch(() => undefined);
  const onStage = (next: StagedSettings) => {
    for (const [key, value] of changedEdits(staged, next)) runtime.stage(key, value);
  };

  // Fields and Save wait while a save writes and while a conflict waits for the person's choice.
  const disabled =
    snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict";

  // A save omp refused, or only part-wrote, is named below with its reason. An environment variable that still
  // overrides a written setting is said in a sentence, and the status pill then does not say Applied.
  const unsavedLabels = settingLabels(descriptor, snapshot.unsavedKeys);
  const override = snapshot.environmentOverride;
  const notice = override === null ? undefined : environmentOverrideText(override);
  const applied = snapshot.applyStatus
    ? applyStatusLabel(snapshot.applyStatus)
    : phaseLabel(snapshot.phase);
  const status =
    snapshot.phase === "conflict"
      ? undefined
      : notice === undefined
        ? applied
        : snapshot.applyStatus && snapshot.applyStatus !== "applied"
          ? applyStatusLabel(snapshot.applyStatus)
          : undefined;

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={`model-settings-${descriptor.title.toLowerCase().replaceAll(" ", "-")}`}
    >
      <SettingsSection
        descriptor={descriptor}
        snapshot={config}
        staged={staged}
        disabled={disabled}
        validation={snapshot.validation}
        applyStatus={status}
        notice={notice}
        unsavedKeys={snapshot.unsavedKeys}
        onStage={onStage}
        onCommit={apply}
        onCancel={() => runtime.cancel()}
      />
      {snapshot.phase === "conflict" && snapshot.conflict ? (
        <ConflictBanner
          description={SETTINGS_CONFLICT_DESCRIPTION}
          heading={SETTINGS_CONFLICT_HEADING}
          keepMineLabel={CONFLICT_BUTTON_LABELS.keepMine}
          onKeepMine={() => runtime.resolveConflict("keep-mine")}
          onReload={() => runtime.resolveConflict("reload")}
          reloadLabel={CONFLICT_BUTTON_LABELS.reload}
          rows={settingsConflictRows(
            descriptor,
            snapshot.conflict.remote,
            snapshot.conflict.changedKeys,
          )}
        />
      ) : unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice labels={unsavedLabels} reason={snapshot.error?.message ?? ""} />
      ) : snapshot.error ? (
        <InlineError message={snapshot.error.message} variant="compact" />
      ) : null}
    </div>
  );
}
