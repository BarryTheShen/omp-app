import { useEffect, useMemo, useState } from "react";
import type { ConflictChoice, SettingsRuntime, SettingsRuntimeSnapshot } from "../../S1/runtime";
import { useSettingsRuntime } from "../../S1/runtime";
import type {
  ApplyStatus,
  ConfigSnapshot,
  PreviewResult,
  SettingsConflictRow,
  SettingsSectionDescriptor,
  StagedSettings,
  ValidationResult,
} from "../../S1/settings-kit";
import { settingsConflictRows } from "../../S1/settings-kit";
import { FILES_READ_SUMMARIES_SECTION } from "../sections";

const SUMMARY_DEPENDENT_KEYS: Readonly<Record<string, true>> = {
  "read.summarize.prose": true,
  "read.summarize.minBodyLines": true,
  "read.summarize.minCommentLines": true,
  "read.summarize.minTotalLines": true,
  "read.summarize.unfoldUntil": true,
  "read.summarize.unfoldLimit": true,
};

export type FilesConflictRow = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
};

export type FilesConflictViewModel = {
  readonly rows: readonly FilesConflictRow[];
};

export type FilesSettingsViewState =
  | {
      readonly kind: "loading";
      readonly id: SettingsSectionDescriptor["id"];
      readonly title: string;
      readonly message: string;
      readonly retryDisabled: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly id: SettingsSectionDescriptor["id"];
      readonly title: string;
      readonly message: string;
      readonly retryDisabled: boolean;
    }
  | {
      readonly kind: "ready";
      readonly descriptor: SettingsSectionDescriptor;
      readonly config: ConfigSnapshot;
      readonly staged: StagedSettings;
      readonly validation: Readonly<Record<string, ValidationResult>>;
      readonly disabled: boolean;
      readonly applyStatus?: string;
      readonly error?: string;
      readonly conflict?: FilesConflictViewModel;
    };

export type FilesSettingsActions = {
  readonly onStage: (staged: StagedSettings) => void;
  readonly onPreview: (key: string, result: PreviewResult) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onResolveConflict: (choice: ConflictChoice) => void;
};

export type FilesSettingsController = {
  readonly state: FilesSettingsViewState;
  readonly actions: FilesSettingsActions;
};

function phaseLabel(phase: SettingsRuntimeSnapshot["phase"]): string | undefined {
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

function applyStatusLabel(status: ApplyStatus): string {
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

function changedEdits(
  before: StagedSettings | null,
  after: StagedSettings,
): readonly [string, StagedSettings["edits"][string]][] {
  const previous = before?.edits ?? {};
  return Object.entries(after.edits).filter(
    ([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
  );
}

function summaryEnabled(snapshot: SettingsRuntimeSnapshot): boolean {
  const staged = snapshot.staged?.edits["read.summarize.enabled"];
  if (staged?.secret === false) return staged.value === true;
  const entry = snapshot.config?.entries.find(
    (candidate) => candidate.key === "read.summarize.enabled",
  );
  return Boolean(entry && !entry.secret && entry.value === true);
}

function displayedDescriptor(snapshot: SettingsRuntimeSnapshot): SettingsSectionDescriptor {
  const descriptor = snapshot.descriptor;
  if (
    descriptor.id !== FILES_READ_SUMMARIES_SECTION.id ||
    !snapshot.config ||
    !snapshot.staged ||
    summaryEnabled(snapshot)
  ) {
    return descriptor;
  }

  const edits = snapshot.staged.edits;
  return {
    ...descriptor,
    controls: descriptor.controls.map((control) =>
      SUMMARY_DEPENDENT_KEYS[control.key] && !(control.key in edits)
        ? { ...control, readOnly: { reason: "Turn on Read Summaries to edit this setting." } }
        : control,
    ),
  };
}

function conflictView(snapshot: SettingsRuntimeSnapshot): FilesConflictViewModel | undefined {
  const conflict = snapshot.conflict;
  if (!conflict) return undefined;
  const rows: readonly SettingsConflictRow[] = settingsConflictRows(
    snapshot.descriptor,
    conflict.remote,
    conflict.changedKeys,
  );
  return { rows };
}

function sectionState(
  snapshot: SettingsRuntimeSnapshot,
  validation: Readonly<Record<string, ValidationResult>>,
): FilesSettingsViewState {
  if (!snapshot.config || !snapshot.staged) {
    const message = snapshot.error?.message ?? phaseLabel(snapshot.phase) ?? "Preparing settings…";
    return snapshot.phase === "error"
      ? {
          kind: "unavailable",
          id: snapshot.descriptor.id,
          title: snapshot.descriptor.title,
          message,
          retryDisabled: false,
        }
      : {
          kind: "loading",
          id: snapshot.descriptor.id,
          title: snapshot.descriptor.title,
          message,
          retryDisabled: snapshot.phase === "loading" || snapshot.phase === "saving",
        };
  }

  const applyStatus = snapshot.applyStatus
    ? applyStatusLabel(snapshot.applyStatus)
    : phaseLabel(snapshot.phase);
  const conflict = conflictView(snapshot);
  return {
    kind: "ready",
    descriptor: displayedDescriptor(snapshot),
    config: snapshot.config,
    staged: snapshot.staged,
    validation,
    disabled:
      snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict",
    ...(applyStatus === undefined ? {} : { applyStatus }),
    ...(snapshot.error && snapshot.phase !== "conflict" ? { error: snapshot.error.message } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

export function useFilesSettingsController(runtime: SettingsRuntime): FilesSettingsController {
  const snapshot = useSettingsRuntime(runtime);
  const [localValidation, setLocalValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});

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
    for (const [key, value] of changedEdits(snapshot.staged, next)) {
      const result = runtime.stage(key, value);
      if (result.ok) clearValidation(key);
      else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
    }
  };

  const onPreview = (key: string, result: PreviewResult) => {
    if (result.ok) clearValidation(key);
    else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
  };

  const onCommit = () => {
    setLocalValidation({});
    void runtime.save().catch(() => undefined);
  };

  const viewState = useMemo(
    () => sectionState(snapshot, { ...snapshot.validation, ...localValidation }),
    [snapshot, localValidation],
  );
  return {
    state: viewState,
    actions: {
      onStage,
      onPreview,
      onCommit,
      onCancel: () => {
        setLocalValidation({});
        runtime.cancel();
      },
      onRetry: () => void runtime.retry().catch(() => undefined),
      onResolveConflict: (choice) => runtime.resolveConflict(choice),
    },
  };
}
