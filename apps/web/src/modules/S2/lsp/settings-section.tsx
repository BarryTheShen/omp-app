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
  environmentOverrideText,
  type PreviewResult,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  type StagedSettings,
  settingLabels,
  settingsConflictRows,
  UnsavedSettingsNotice,
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

export function RuntimeSettingsSection({
  runtime,
  onDirtyChange,
}: {
  readonly runtime: SettingsRuntime;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const snapshot = useSettingsRuntime(runtime);
  const [localValidation, setLocalValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const descriptor = snapshot.descriptor;
  const config = snapshot.config;
  const staged = snapshot.staged;
  const disabled =
    snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict";
  const hasStagedChanges =
    Object.keys(staged?.edits ?? {}).length > 0 || snapshot.unsavedKeys.length > 0;
  const unsavedLabels = settingLabels(descriptor, snapshot.unsavedKeys);

  useEffect(() => {
    onDirtyChange?.(hasStagedChanges);
  }, [hasStagedChanges, onDirtyChange]);
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

  const retry = async (): Promise<void> => {
    setActionError(null);
    try {
      await runtime.retry();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Settings could not be loaded.");
    }
  };

  const apply = (): void => {
    setLocalValidation({});
    setActionError(null);
    void runtime.save().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : "Settings could not be saved.");
    });
  };

  if (config === null || staged === null) {
    return (
      <div
        className="flex min-w-0 flex-col gap-3"
        data-testid={`settings-runtime-${descriptor.id}`}
      >
        <Section heading={descriptor.title} headingId={`${descriptor.id}-loading-title`}>
          {snapshot.phase === "error" ? (
            <InlineError
              heading="Could not load settings"
              message={actionError ?? snapshot.error?.message ?? "Settings could not be loaded."}
              onRetry={() => void retry()}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {phaseLabel(snapshot.phase) ?? "Preparing settings…"}
            </p>
          )}
        </Section>
      </div>
    );
  }

  const override =
    snapshot.environmentOverride === null
      ? undefined
      : environmentOverrideText(snapshot.environmentOverride);
  const applied = snapshot.applyStatus
    ? applyStatusLabel(snapshot.applyStatus)
    : phaseLabel(snapshot.phase);
  const status =
    snapshot.phase === "conflict"
      ? undefined
      : override === undefined
        ? applied
        : snapshot.applyStatus && snapshot.applyStatus !== "applied"
          ? applyStatusLabel(snapshot.applyStatus)
          : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`settings-runtime-${descriptor.id}`}>
      <SettingsSection
        descriptor={descriptor}
        snapshot={config}
        staged={staged}
        disabled={disabled}
        validation={{ ...snapshot.validation, ...localValidation }}
        applyStatus={status}
        notice={override}
        unsavedKeys={snapshot.unsavedKeys}
        onStage={onStage}
        onPreview={onPreview}
        onCommit={apply}
        onCancel={() => {
          setActionError(null);
          setLocalValidation({});
          runtime.cancel();
        }}
      />
      {snapshot.conflict ? (
        <ConflictBanner
          description={SETTINGS_CONFLICT_DESCRIPTION}
          heading={SETTINGS_CONFLICT_HEADING}
          keepMineLabel={CONFLICT_BUTTON_LABELS.keepMine}
          onKeepMine={() => {
            setActionError(null);
            runtime.resolveConflict("keep-mine");
          }}
          onReload={() => {
            setActionError(null);
            runtime.resolveConflict("reload");
          }}
          reloadLabel={CONFLICT_BUTTON_LABELS.reload}
          rows={settingsConflictRows(
            descriptor,
            snapshot.conflict.remote,
            snapshot.conflict.changedKeys,
          )}
        />
      ) : null}
      {snapshot.errorOperation === "save" &&
      snapshot.phase !== "error" &&
      unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice
          labels={unsavedLabels}
          reason={actionError ?? snapshot.error?.message ?? ""}
        />
      ) : snapshot.phase !== "conflict" &&
        (snapshot.phase === "error" || actionError || snapshot.error) ? (
        <InlineError
          heading={
            snapshot.errorOperation === "refresh"
              ? "Could not refresh settings"
              : "Could not save changes"
          }
          message={
            actionError ??
            (snapshot.error === null
              ? "Settings could not be saved."
              : hasStagedChanges
                ? `${snapshot.error.message} Your changes are still waiting to be saved.`
                : snapshot.error.message)
          }
          onRetry={hasStagedChanges ? undefined : () => void retry()}
          variant="boxed"
        />
      ) : null}
    </div>
  );
}
