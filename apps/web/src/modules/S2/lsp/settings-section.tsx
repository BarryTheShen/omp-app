import { useEffect, useState } from "react";
import { ConflictBanner, InlineError, Section } from "@/components/blocks";
import {
  type SettingsRuntime,
  type SettingsRuntimeSnapshot,
  useSettingsRuntime,
} from "../../S1/runtime";
import {
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  type PreviewResult,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  type StagedSettings,
  settingsConflictRows,
  type ValidationResult,
} from "../../S1/settings-kit";

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

export function RuntimeSettingsSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  const snapshot = useSettingsRuntime(runtime);
  const [localValidation, setLocalValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});
  const descriptor = snapshot.descriptor;
  const config = snapshot.config;
  const staged = snapshot.staged;
  const disabled =
    snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict";
  const hasStagedChanges =
    Object.keys(staged?.edits ?? {}).length > 0 || snapshot.unsavedKeys.length > 0;

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
        <Section heading={descriptor.title} headingId={`${descriptor.id}-loading-title`}>
          {snapshot.phase === "error" ? (
            <InlineError
              heading="Could not load settings"
              message={snapshot.error?.message ?? "Settings could not be loaded."}
              onRetry={() =>
                runtime
                  .retry()
                  .then(() => undefined)
                  .catch(() => undefined)
              }
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {phaseLabel(snapshot.phase) ?? "Preparing settings…"}
            </p>
          )}
        </Section>
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
        <InlineError
          heading={
            snapshot.errorOperation === "refresh"
              ? "Could not refresh settings"
              : "Could not save changes"
          }
          message={
            snapshot.errorOperation === "refresh"
              ? hasStagedChanges
                ? `${snapshot.error.message} Your changes are still waiting to be saved.`
                : snapshot.error.message
              : hasStagedChanges
                ? `${snapshot.error.message} Your changes are still waiting to be saved. Review them and try Save changes again.`
                : snapshot.error.message
          }
          variant="boxed"
        />
      ) : null}
    </div>
  );
}
