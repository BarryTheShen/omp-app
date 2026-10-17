import { useEffect, useState } from "react";
import { ConflictBanner } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import {
  type SettingsRuntime,
  type SettingsRuntimeSnapshot,
  useSettingsRuntime,
} from "../../S1/runtime";
import {
  type ApplyBoundary,
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  type PreviewResult,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  settingsConflictRows,
  type ValidationResult,
} from "../../S1/settings-kit";

const APPLY_REPORT: Readonly<
  Record<ApplyBoundary, { readonly label: string; readonly detail: string }>
> = {
  live: {
    label: "Live",
    detail: "New operations use the saved value; in-progress operations are not interrupted.",
  },
  session: {
    label: "This session",
    detail: "New operations in this session use the saved value; active processes keep running.",
  },
  reload: {
    label: "Reload required",
    detail:
      "Reload the affected feature for the full effect; saving does not stop a running process.",
  },
  restart: {
    label: "Restart required",
    detail:
      "Restart the affected runtime for the full effect; saving never terminates it automatically.",
  },
  unsupported: {
    label: "Unavailable",
    detail: "The current host cannot apply this setting.",
  },
};

function phaseLabel(phase: SettingsRuntimeSnapshot["phase"]): string | undefined {
  switch (phase) {
    case "loading":
      return "Loading settings…";
    case "saving":
      return "Saving…";
    case "conflict":
      return undefined;
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

export function SettingsApplyReport({
  descriptor,
}: {
  readonly descriptor: SettingsSectionDescriptor;
}) {
  const grouped = new Map<ApplyBoundary, string[]>();
  for (const control of descriptor.controls) {
    const labels = grouped.get(control.apply) ?? [];
    labels.push(control.label);
    grouped.set(control.apply, labels);
  }

  return (
    <section aria-label="When settings take effect" className="text-sm">
      <h3 className="font-medium text-foreground">When changes take effect</h3>
      <ul className="mt-2 flex flex-col gap-2 text-muted-foreground">
        {[...grouped].map(([boundary, labels]) => {
          const report = APPLY_REPORT[boundary];
          return (
            <li key={boundary}>
              <strong className="font-medium text-foreground">{report.label}:</strong>{" "}
              {labels.join(", ")}. {report.detail}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RuntimeSettingsSection({
  runtime,
  behaviorNote,
}: {
  readonly runtime: SettingsRuntime;
  readonly behaviorNote: string;
}) {
  const snapshot = useSettingsRuntime(runtime);
  const [localValidation, setLocalValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});
  const descriptor = snapshot.descriptor;
  const config = snapshot.config;
  const staged = snapshot.staged;
  const disabled =
    snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict";

  useEffect(() => {
    if (snapshot.phase === "idle") void runtime.read().catch(() => undefined);
  }, [runtime, snapshot.phase]);

  const clearValidation = (key: string) => {
    setLocalValidation((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const onStage = (next: StagedSettings) => {
    for (const [key, value] of changedEdits(staged, next)) {
      const result = runtime.stage(key, value);
      if (result.ok) clearValidation(key);
      else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
    }
  };

  const onPreview = (key: string, result: PreviewResult) => {
    if (result.ok) clearValidation(key);
    else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
  };

  const apply = () => {
    setLocalValidation({});
    void runtime.save().catch(() => undefined);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`settings-runtime-${descriptor.id}`}>
      {config && staged ? (
        <SettingsSection
          descriptor={descriptor}
          snapshot={config}
          staged={staged}
          disabled={disabled}
          validation={{ ...snapshot.validation, ...localValidation }}
          applyStatus={
            snapshot.phase === "conflict"
              ? undefined
              : snapshot.applyStatus
                ? applyStatusLabel(snapshot.applyStatus)
                : phaseLabel(snapshot.phase)
          }
          onStage={onStage}
          onPreview={onPreview}
          onCommit={apply}
          onCancel={() => {
            setLocalValidation({});
            runtime.cancel();
          }}
        />
      ) : (
        <section
          aria-labelledby={`${descriptor.id}-loading-title`}
          className="flex min-h-40 flex-col gap-3 rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
        >
          <h2
            id={`${descriptor.id}-loading-title`}
            className="text-lg font-semibold tracking-tight"
          >
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
            disabled={disabled}
            onClick={() => void runtime.retry().catch(() => undefined)}
          >
            Retry
          </Button>
        </section>
      )}

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
      ) : null}

      {snapshot.error && snapshot.phase !== "conflict" && config ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error.message} Your edits remain staged; review them and try Save changes again.
        </p>
      ) : null}

      <SettingsApplyReport descriptor={descriptor} />
      <p className="text-sm text-muted-foreground">{behaviorNote}</p>
    </div>
  );
}
