import { useEffect, useState } from "react";
import {
  type ConflictChoice,
  type SettingsRuntime,
  type SettingsRuntimeSnapshot,
  useSettingsRuntime,
} from "../../S1/runtime";
import type {
  PreviewResult,
  SettingsSectionDescriptor,
  StagedSettings,
  ValidationResult,
} from "../../S1/settings-kit";
import type { MEMORY_SETTINGS_SECTIONS } from "./descriptors";

export type MemorySettingsRuntimes = Readonly<
  Record<(typeof MEMORY_SETTINGS_SECTIONS)[number]["id"], SettingsRuntime>
>;

export type MemorySettingsSectionState = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly snapshot: SettingsRuntimeSnapshot;
  readonly validation: Readonly<Record<string, ValidationResult>>;
};

export type MemorySettingsViewModel = {
  readonly sections: readonly MemorySettingsSectionState[];
  readonly activeSectionId: SettingsSectionDescriptor["id"];
};

export type MemorySettingsActions = {
  readonly onSelectSection: (id: SettingsSectionDescriptor["id"]) => void;
  readonly onStage: (id: SettingsSectionDescriptor["id"], staged: StagedSettings) => void;
  readonly onPreview: (
    id: SettingsSectionDescriptor["id"],
    key: string,
    result: PreviewResult,
  ) => void;
  readonly onCommit: (id: SettingsSectionDescriptor["id"]) => void;
  readonly onCancel: (id: SettingsSectionDescriptor["id"]) => void;
  readonly onRetry: (id: SettingsSectionDescriptor["id"]) => void;
  readonly onSecretAction: (
    id: SettingsSectionDescriptor["id"],
    key: string,
    action: "set" | "unset",
  ) => void;
  readonly onResolveConflict: (id: SettingsSectionDescriptor["id"], choice: ConflictChoice) => void;
};

export type MemorySettingsController = {
  readonly model: MemorySettingsViewModel;
  readonly actions: MemorySettingsActions;
};

function runtimeFor(
  runtimes: MemorySettingsRuntimes,
  id: SettingsSectionDescriptor["id"],
): SettingsRuntime {
  const runtime = runtimes[id as keyof MemorySettingsRuntimes];
  if (!runtime) throw new Error(`Missing memory settings runtime for ${id}`);
  return runtime;
}

function sectionState(snapshot: SettingsRuntimeSnapshot): MemorySettingsSectionState {
  return { descriptor: snapshot.descriptor, snapshot, validation: snapshot.validation };
}

export function useMemorySettingsController(
  runtimes: MemorySettingsRuntimes,
): MemorySettingsController {
  const general = useSettingsRuntime(runtimeFor(runtimes, "I3.memoryGeneral"));
  const autoLearn = useSettingsRuntime(runtimeFor(runtimes, "I3.memoryAutoLearn"));
  const hindsight = useSettingsRuntime(runtimeFor(runtimes, "I3.memoryHindsight"));
  const mnemopi = useSettingsRuntime(runtimeFor(runtimes, "I3.memoryMnemopi"));
  const sharpshooter = useSettingsRuntime(runtimeFor(runtimes, "I3.memorySharpshooter"));
  const [activeSectionId, setActiveSectionId] =
    useState<SettingsSectionDescriptor["id"]>("I3.memoryGeneral");
  const snapshots = [general, autoLearn, hindsight, mnemopi, sharpshooter];

  useEffect(() => {
    // The runtime commits read failures to its snapshot, which is rendered as a recoverable error.
    for (const runtime of Object.values(runtimes)) void runtime.read().catch(() => undefined);
  }, [runtimes]);
  const sections = snapshots.map(sectionState);
  const actions: MemorySettingsActions = {
    onSelectSection: setActiveSectionId,
    onStage: (id, staged) => {
      const runtime = runtimeFor(runtimes, id);
      for (const [key, value] of Object.entries(staged.edits)) runtime.stage(key, value);
    },
    onPreview: () => undefined,
    // Save/retry failures are recorded in SettingsRuntime's snapshot and shown by the view.
    onCommit: (id) =>
      void runtimeFor(runtimes, id)
        .save()
        .catch(() => undefined),
    onCancel: (id) => runtimeFor(runtimes, id).cancel(),
    onRetry: (id) =>
      void runtimeFor(runtimes, id)
        .retry()
        .catch(() => undefined),
    onSecretAction: (id, key, action) => {
      if (action === "unset") runtimeFor(runtimes, id).stage(key, { secret: true, action });
    },
    onResolveConflict: (id, choice) => void runtimeFor(runtimes, id).resolveConflict(choice),
  };
  return { model: { sections, activeSectionId }, actions };
}
