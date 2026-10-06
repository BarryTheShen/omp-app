import type { ConfigWriteLayer, FolderPath, JsonValue } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IMAGES_SETTINGS_SECTION,
  S1_APPEARANCE_SECTIONS,
  THEME_SETTINGS_SECTION,
} from "../appearance";
import {
  type AppearancePreviewModel,
  type AppearanceThemeKey,
  composerPreviewNote,
  previewOmpTheme,
} from "../appearance/preview";
import type { ConflictChoice, SettingsRuntimeConflict, SettingsRuntimeSnapshot } from "../runtime";
import { SettingsRuntime } from "../runtime";
import type {
  ApplyStatus,
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  PreviewResult,
  SettingsSectionDescriptor,
  SettingValue,
  StagedSettings,
  ValidationResult,
} from "../settings-kit";

export type AppearanceSettingsControllerOptions = {
  readonly client: ConfigStoreClient;
  readonly changes: ConfigChangeSource;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
};

export type AppearanceSettingsSectionModel = {
  readonly id: string;
  readonly title: string;
  readonly selected: boolean;
};

export type AppearanceSettingsActiveSectionModel = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly snapshot: ConfigSnapshot;
  readonly staged: StagedSettings;
  readonly validation: Readonly<Record<string, ValidationResult>>;
  readonly disabled: boolean;
  readonly conflict: SettingsRuntimeConflict | null;
  readonly applyStatus: ApplyStatus | null;
  readonly error?: string;
  readonly selectorActions?: "theme" | "images";
};

export type AppearanceSettingsSelectorModel =
  | { readonly kind: "theme"; readonly key: AppearanceThemeKey; readonly value: string }
  | { readonly kind: "images"; readonly value: boolean };

export type AppearanceSettingsViewModel = {
  readonly sections: readonly AppearanceSettingsSectionModel[];
  readonly activeSection?: AppearanceSettingsActiveSectionModel;
  readonly selector?: AppearanceSettingsSelectorModel;
  readonly search: string;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly emptyMessage?: string;
  readonly actionError?: string;
  readonly layer: ConfigWriteLayer;
  readonly preview: AppearancePreviewModel;
};

export type AppearanceSettingsActions = {
  readonly onSearch: (value: string) => void;
  readonly onSelectSection: (id: string) => void;
  readonly onRetryLoad: () => void;
  readonly onOpenThemeSelector: (key: AppearanceThemeKey) => void;
  readonly onOpenImagesSelector: () => void;
  readonly onThemeValueChange: (value: string) => void;
  readonly onThemePreview: (value: string) => void;
  readonly onThemeSelect: (value: string) => void;
  readonly onImagesPreview: (value: boolean) => void;
  readonly onImagesSelect: (value: boolean) => void;
  readonly onCancelSelector: () => void;
  readonly onStage: (sectionId: string, staged: StagedSettings) => void;
  readonly onPreview: (key: string, result: PreviewResult) => void;
  readonly onCommit: (sectionId: string) => void;
  readonly onCancel: (sectionId: string) => void;
  readonly onRetrySection: (sectionId: string) => void;
  readonly onConflictChoice: (sectionId: string, choice: ConflictChoice) => void;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
};

type SectionRuntime = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly runtime: SettingsRuntime;
};

type SelectorState =
  | { readonly kind: "theme"; readonly key: AppearanceThemeKey; readonly value: string }
  | { readonly kind: "images" };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function findSectionRuntime(
  sections: readonly SectionRuntime[],
  key: string,
): SectionRuntime | undefined {
  return sections.find((section) =>
    section.descriptor.controls.some((control) => control.key === key),
  );
}

function effectiveValue(
  snapshot: SettingsRuntimeSnapshot | undefined,
  key: string,
  previewValues: Readonly<Record<string, JsonValue>>,
): JsonValue | undefined {
  if (Object.hasOwn(previewValues, key)) return previewValues[key];
  const staged = snapshot?.staged?.edits[key];
  if (staged && !staged.secret) return staged.value;
  const entry = snapshot?.config?.entries.find((candidate) => candidate.key === key);
  return entry && !entry.secret ? entry.value : undefined;
}

function valueFromSections(
  snapshots: readonly SettingsRuntimeSnapshot[],
  key: string,
  previewValues: Readonly<Record<string, JsonValue>>,
): JsonValue | undefined {
  const snapshot = snapshots.find((candidate) =>
    candidate.descriptor.controls.some((control) => control.key === key),
  );
  return effectiveValue(snapshot, key, previewValues);
}

function stringSetting(
  snapshots: readonly SettingsRuntimeSnapshot[],
  key: string,
  previewValues: Readonly<Record<string, JsonValue>>,
  fallback: string,
): string {
  const value = valueFromSections(snapshots, key, previewValues);
  return typeof value === "string" ? value : fallback;
}

function booleanSetting(
  snapshots: readonly SettingsRuntimeSnapshot[],
  key: string,
  previewValues: Readonly<Record<string, JsonValue>>,
  fallback: boolean,
): boolean {
  const value = valueFromSections(snapshots, key, previewValues);
  return typeof value === "boolean" ? value : fallback;
}

function browserPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

function previewModel(
  snapshots: readonly SettingsRuntimeSnapshot[],
  previewValues: Readonly<Record<string, JsonValue>>,
  activeThemeKey?: AppearanceThemeKey,
): AppearancePreviewModel {
  const preferredThemeKey: AppearanceThemeKey =
    activeThemeKey ?? (browserPrefersDark() ? "theme.dark" : "theme.light");
  const themeName = stringSetting(
    snapshots,
    preferredThemeKey,
    previewValues,
    preferredThemeKey === "theme.dark" ? "titanium" : "light",
  );
  const theme = previewOmpTheme(preferredThemeKey, themeName);
  const composerShape = stringSetting(snapshots, "composer.shape", previewValues, "band");
  return {
    palette: theme.palette,
    themeNote: theme.note,
    composerShape,
    composerNote: composerPreviewNote(composerShape),
    statusLinePreset: stringSetting(snapshots, "statusLine.preset", previewValues, "default"),
    statusLineSeparator: stringSetting(
      snapshots,
      "statusLine.separator",
      previewValues,
      "powerline-thin",
    ),
    contextLine: stringSetting(snapshots, "statusLine.contextLine", previewValues, "embedded"),
    hideToolActivity: booleanSetting(snapshots, "display.hideToolActivity", previewValues, false),
    showTokenUsage: booleanSetting(snapshots, "display.showTokenUsage", previewValues, false),
    showTurnTime: booleanSetting(snapshots, "display.showTurnTime", previewValues, false),
    showCacheMissMarker: booleanSetting(snapshots, "display.cacheMissMarker", previewValues, false),
    showCompactedHistory: booleanSetting(
      snapshots,
      "display.collapseCompacted",
      previewValues,
      true,
    ),
    showImages: booleanSetting(snapshots, "terminal.showImages", previewValues, true),
  };
}

function useRuntimeSnapshots(
  runtimes: readonly SectionRuntime[],
): readonly SettingsRuntimeSnapshot[] {
  const [snapshots, setSnapshots] = useState<readonly SettingsRuntimeSnapshot[]>(() =>
    runtimes.map(({ runtime }) => runtime.getSnapshot()),
  );
  useEffect(() => {
    const publish = () => setSnapshots(runtimes.map(({ runtime }) => runtime.getSnapshot()));
    const unsubscribe = runtimes.map(({ runtime }) => runtime.subscribe(publish));
    publish();
    return () => {
      for (const stop of unsubscribe) stop();
    };
  }, [runtimes]);
  return snapshots;
}

function stageNext(
  runtime: SettingsRuntime,
  descriptor: SettingsSectionDescriptor,
  next: StagedSettings,
): void {
  const previous = runtime.getSnapshot().staged;
  for (const control of descriptor.controls) {
    const value = next.edits[control.key];
    if (!value || JSON.stringify(previous?.edits[control.key]) === JSON.stringify(value)) continue;
    runtime.stage(control.key, value);
  }
}

function previewPatchValue(result: PreviewResult): JsonValue | undefined {
  if (!result.ok || !result.patch) return undefined;
  const value = result.patch.value;
  if (typeof value === "object" && value !== null && "secret" in value) return undefined;
  return value;
}

export function useAppearanceSettingsController({
  client,
  changes,
  folder,
  layer,
  onSecretAction,
}: AppearanceSettingsControllerOptions): {
  readonly model: AppearanceSettingsViewModel;
  readonly actions: AppearanceSettingsActions;
} {
  const [runtimes, setRuntimes] = useState<readonly SectionRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [activeSectionId, setActiveSectionId] = useState<string>(THEME_SETTINGS_SECTION.id);
  const [search, setSearch] = useState("");
  const [selector, setSelector] = useState<SelectorState | undefined>();
  const [previewValues, setPreviewValues] = useState<Readonly<Record<string, JsonValue>>>({});
  const [activeThemeKey, setActiveThemeKey] = useState<AppearanceThemeKey | undefined>();
  const originalDarkClass = useRef<boolean | undefined>(undefined);
  const snapshots = useRuntimeSnapshots(runtimes);

  useEffect(() => {
    let mounted = true;
    const next = S1_APPEARANCE_SECTIONS.map((descriptor) => ({
      descriptor,
      runtime: new SettingsRuntime(client, changes, { descriptor, folder, layer }),
    }));
    setRuntimes(next);
    setLoading(true);
    setLoadError(undefined);
    void Promise.all(next.map(({ runtime }) => runtime.read()))
      .then(() => {
        if (mounted) setLoading(false);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setLoadError(errorMessage(error, "Appearance settings could not be loaded."));
        setLoading(false);
      });
    return () => {
      mounted = false;
      for (const entry of next) {
        entry.runtime.cancel();
        entry.runtime.dispose();
      }
    };
  }, [client, changes, folder, layer]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (originalDarkClass.current === undefined) {
      originalDarkClass.current = document.documentElement.classList.contains("dark");
    }
    return () => {
      if (originalDarkClass.current !== undefined) {
        document.documentElement.classList.toggle("dark", originalDarkClass.current);
      }
    };
  }, []);

  const loaded =
    snapshots.length === S1_APPEARANCE_SECTIONS.length &&
    snapshots.every((snapshot) => snapshot.config !== null);
  const preview = previewModel(snapshots, previewValues, activeThemeKey);

  useEffect(() => {
    if (loaded && typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", preview.palette === "dark");
    }
  }, [loaded, preview.palette]);

  const visibleDescriptors = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return S1_APPEARANCE_SECTIONS;
    return S1_APPEARANCE_SECTIONS.filter((descriptor) =>
      descriptor.controls.some((control) =>
        `${control.key} ${control.label} ${control.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      ),
    );
  }, [search]);
  const selectedSectionId = visibleDescriptors.some(({ id }) => id === activeSectionId)
    ? activeSectionId
    : visibleDescriptors[0]?.id;
  const activeDescriptor = visibleDescriptors.find(({ id }) => id === selectedSectionId);
  const activeRuntime = runtimes.find(({ descriptor }) => descriptor.id === activeDescriptor?.id);
  const activeSnapshot = snapshots.find(({ descriptor }) => descriptor.id === activeDescriptor?.id);

  function currentSetting(key: string): JsonValue | undefined {
    return valueFromSections(snapshots, key, previewValues);
  }

  function clearPreview(descriptor: SettingsSectionDescriptor): void {
    setPreviewValues((current) => {
      const next = { ...current };
      for (const control of descriptor.controls) delete next[control.key];
      return next;
    });
    if (descriptor.id === THEME_SETTINGS_SECTION.id) setActiveThemeKey(undefined);
    setActionError(undefined);
  }

  const setPreviewResult = useCallback((key: string, result: PreviewResult) => {
    if (!result.ok) {
      setActionError(result.validation.message);
      return;
    }
    const value = previewPatchValue(result);
    if (value === undefined) {
      setPreviewValues((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (key === "theme.dark" || key === "theme.light") setActiveThemeKey(undefined);
      return;
    }
    setActionError(undefined);
    setPreviewValues((current) => ({ ...current, [key]: value }));
    if (key === "theme.dark" || key === "theme.light") setActiveThemeKey(key);
  }, []);

  function previewControlValue(key: string, value: JsonValue): void {
    const section = findSectionRuntime(runtimes, key);
    const control = section?.descriptor.controls.find((candidate) => candidate.key === key);
    const snapshot = section?.runtime.getSnapshot().config;
    if (!control || !snapshot) return;
    const setting: SettingValue = { secret: false, value };
    const validation = control.validate(setting, snapshot);
    if (!validation.valid) {
      setActionError(validation.message);
      return;
    }
    setPreviewResult(key, { ok: true, patch: control.preview?.(setting, snapshot) ?? null });
  }

  function openThemeSelector(key: AppearanceThemeKey): void {
    const value = currentSetting(key);
    setSelector({
      kind: "theme",
      key,
      value: typeof value === "string" ? value : key === "theme.dark" ? "titanium" : "light",
    });
    setActionError(undefined);
  }

  function changeThemeValue(value: string): void {
    setSelector((current) => (current?.kind === "theme" ? { ...current, value } : current));
  }

  function selectValue(key: string, value: JsonValue): void {
    const section = findSectionRuntime(runtimes, key);
    if (!section) return;
    const result = section.runtime.stage(key, { secret: false, value });
    if (!result.ok) {
      setActionError(result.validation.message);
      return;
    }
    setPreviewResult(key, section.runtime.preview(key));
    setSelector(undefined);
    setActiveSectionId(section.descriptor.id);
  }

  async function retryLoad(): Promise<void> {
    setLoading(true);
    setLoadError(undefined);
    try {
      await Promise.all(runtimes.map(({ runtime }) => runtime.retry()));
    } catch (error) {
      setLoadError(errorMessage(error, "Appearance settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  async function saveSection(sectionId: string): Promise<void> {
    const section = runtimes.find(({ descriptor }) => descriptor.id === sectionId);
    if (!section) return;
    setActionError(undefined);
    try {
      await section.runtime.save();
      clearPreview(section.descriptor);
    } catch (error) {
      setActionError(errorMessage(error, "Appearance settings could not be saved."));
    }
  }

  function cancelSection(sectionId: string): void {
    const section = runtimes.find(({ descriptor }) => descriptor.id === sectionId);
    if (!section) return;
    section.runtime.cancel();
    clearPreview(section.descriptor);
  }

  function cancelSelector(): void {
    if (selector?.kind === "theme") {
      const section = findSectionRuntime(runtimes, selector.key);
      if (section) clearPreview(section.descriptor);
    }
    if (selector?.kind === "images") {
      const section = findSectionRuntime(runtimes, "terminal.showImages");
      if (section) clearPreview(section.descriptor);
    }
    setSelector(undefined);
  }

  const showImagesValue = currentSetting("terminal.showImages");
  const model: AppearanceSettingsViewModel = {
    sections: visibleDescriptors.map((descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      selected: descriptor.id === selectedSectionId,
    })),
    activeSection:
      activeDescriptor &&
      activeSnapshot &&
      activeRuntime &&
      activeSnapshot.config &&
      activeSnapshot.staged
        ? {
            descriptor: {
              ...activeDescriptor,
              controls: activeDescriptor.controls.filter((control) =>
                `${control.key} ${control.label} ${control.description ?? ""}`
                  .toLocaleLowerCase()
                  .includes(search.trim().toLocaleLowerCase()),
              ),
            },
            snapshot: activeSnapshot.config,
            staged: activeSnapshot.staged,
            validation: activeSnapshot.validation,
            disabled:
              activeSnapshot.phase === "loading" ||
              activeSnapshot.phase === "saving" ||
              activeSnapshot.phase === "conflict",
            conflict: activeSnapshot.conflict,
            applyStatus: activeSnapshot.applyStatus,
            error: activeSnapshot.error?.message,
            selectorActions:
              activeDescriptor.id === THEME_SETTINGS_SECTION.id
                ? "theme"
                : activeDescriptor.id === IMAGES_SETTINGS_SECTION.id
                  ? "images"
                  : undefined,
          }
        : undefined,
    selector:
      selector?.kind === "theme"
        ? selector
        : selector?.kind === "images"
          ? {
              kind: "images",
              value: typeof showImagesValue === "boolean" ? showImagesValue : true,
            }
          : undefined,
    search,
    loading,
    loadError,
    emptyMessage:
      !loading && !loadError && !activeDescriptor
        ? search.trim()
          ? `No appearance settings match “${search.trim()}”.`
          : "Appearance settings are unavailable."
        : undefined,
    actionError,
    layer,
    preview,
  };

  const actions: AppearanceSettingsActions = {
    onSearch: setSearch,
    onSelectSection: setActiveSectionId,
    onRetryLoad: () => void retryLoad(),
    onOpenThemeSelector: openThemeSelector,
    onOpenImagesSelector: () => {
      setSelector({ kind: "images" });
      setActionError(undefined);
    },
    onThemeValueChange: changeThemeValue,
    onThemePreview: (value) => {
      if (selector?.kind === "theme") previewControlValue(selector.key, value);
    },
    onThemeSelect: (value) => {
      if (selector?.kind === "theme") selectValue(selector.key, value);
    },
    onImagesPreview: (value) => previewControlValue("terminal.showImages", value),
    onImagesSelect: (value) => selectValue("terminal.showImages", value),
    onCancelSelector: cancelSelector,
    onStage: (sectionId, staged) => {
      const section = runtimes.find(({ descriptor }) => descriptor.id === sectionId);
      if (!section) return;
      setActionError(undefined);
      stageNext(section.runtime, section.descriptor, staged);
    },
    onPreview: (key, result) => setPreviewResult(key, result),
    onCommit: (sectionId) => void saveSection(sectionId),
    onCancel: cancelSection,
    onRetrySection: (sectionId) => {
      const section = runtimes.find(({ descriptor }) => descriptor.id === sectionId);
      if (!section) return;
      void section.runtime.retry().catch((error: unknown) => {
        setActionError(errorMessage(error, "Appearance settings could not be read."));
      });
    },
    onConflictChoice: (sectionId, choice) => {
      runtimes
        .find(({ descriptor }) => descriptor.id === sectionId)
        ?.runtime.resolveConflict(choice);
    },
    onSecretAction,
  };
  return { model, actions };
}
