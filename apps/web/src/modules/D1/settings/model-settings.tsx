import { useEffect } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import {
  environmentOverrideText,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  settingLabels,
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
  // A failed save is recorded in the runtime's snapshot (its error and unsaved keys), which is shown below.
  const apply = () => void runtime.save().catch(() => undefined);
  const onStage = (next: StagedSettings) => {
    for (const [key, value] of changedEdits(staged, next)) runtime.stage(key, value);
  };

  // A save omp refused, or only part-wrote, is named below with its reason. An environment variable that still
  // overrides a written setting is said in a sentence, and the status pill then does not say Applied.
  const unsavedLabels = settingLabels(descriptor, snapshot.unsavedKeys);
  const override = snapshot.environmentOverride;
  const notice = override === null ? undefined : environmentOverrideText(override);
  const applied = snapshot.applyStatus
    ? applyStatusLabel(snapshot.applyStatus)
    : phaseLabel(snapshot.phase);
  const status =
    notice === undefined
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
        validation={snapshot.validation}
        applyStatus={status}
        notice={notice}
        unsavedKeys={snapshot.unsavedKeys}
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
      ) : unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice labels={unsavedLabels} reason={snapshot.error?.message ?? ""} />
      ) : snapshot.error ? (
        <InlineError message={snapshot.error.message} variant="compact" />
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
