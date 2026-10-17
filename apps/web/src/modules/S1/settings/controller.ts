import type { ConfigWriteLayer, FolderPath, JsonValue } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IMAGES_SETTINGS_SECTION,
  S1_APPEARANCE_SECTIONS,
  THEME_SETTINGS_SECTION,
} from "../appearance";
import type { AppearanceThemeKey } from "../appearance/selectors";
import type { ConflictChoice, SettingsRuntimeConflict, SettingsRuntimeSnapshot } from "../runtime";
import { SettingsRuntime } from "../runtime";
import type {
  ApplyStatus,
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingsConflictRow,
  SettingsSectionDescriptor,
  StagedSettings,
  ValidationResult,
} from "../settings-kit";
import { settingLabels, settingsConflictRows } from "../settings-kit";

export type AppearanceSettingsControllerOptions = {
  readonly client: ConfigStoreClient;
  readonly changes: ConfigChangeSource;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
  /** The registry-selected appearance sections to load and show. */
  readonly appearanceSections?: readonly SettingsSectionDescriptor[];
  /** The first section selected when the view opens. */
  readonly initialSectionId?: string;
  /** Keep the legacy terminal-theme preview behavior for the standalone S1 surface. */
  readonly applyThemePreview?: boolean;
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
  readonly conflictRows: readonly SettingsConflictRow[];
  readonly applyStatus: ApplyStatus | null;
  readonly error?: string;
  /** Keys of the last save that omp did not write, marked on their rows. */
  readonly unsavedKeys: readonly string[];
  /** Their labels, in the order the section shows them, for the notice that names them. */
  readonly unsavedLabels: readonly string[];
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
};

export type AppearanceSettingsActions = {
  readonly onSearch: (value: string) => void;
  readonly onSelectSection: (id: string) => void;
  readonly onRetryLoad: () => void;
  readonly onOpenThemeSelector: (key: AppearanceThemeKey) => void;
  readonly onOpenImagesSelector: () => void;
  readonly onThemeValueChange: (value: string) => void;
  readonly onThemeSelect: (value: string) => void;
  readonly onImagesSelect: (value: boolean) => void;
  readonly onCancelSelector: () => void;
  readonly onStage: (sectionId: string, staged: StagedSettings) => void;
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

function valueFromSections(
  snapshots: readonly SettingsRuntimeSnapshot[],
  key: string,
): JsonValue | undefined {
  const snapshot = snapshots.find((candidate) =>
    candidate.descriptor.controls.some((control) => control.key === key),
  );
  const staged = snapshot?.staged?.edits[key];
  if (staged && !staged.secret) return staged.value;
  const entry = snapshot?.config?.entries.find((candidate) => candidate.key === key);
  return entry && !entry.secret ? entry.value : undefined;
}

function stringSetting(
  snapshots: readonly SettingsRuntimeSnapshot[],
  key: string,
  fallback: string,
): string {
  const value = valueFromSections(snapshots, key);
  return typeof value === "string" ? value : fallback;
}

function browserPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
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

export function useAppearanceSettingsController({
  client,
  changes,
  folder,
  layer,
  onSecretAction,
  appearanceSections = S1_APPEARANCE_SECTIONS,
  initialSectionId = appearanceSections[0]?.id ?? THEME_SETTINGS_SECTION.id,
  applyThemePreview = false,
}: AppearanceSettingsControllerOptions): {
  readonly model: AppearanceSettingsViewModel;
  readonly actions: AppearanceSettingsActions;
} {
  const [runtimes, setRuntimes] = useState<readonly SectionRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [activeSectionId, setActiveSectionId] = useState<string>(initialSectionId);
  const [search, setSearch] = useState("");
  const [selector, setSelector] = useState<SelectorState | undefined>();
  const [themePreview, setThemePreview] = useState<
    { readonly key: AppearanceThemeKey; readonly value: string } | undefined
  >();
  const originalDarkClass = useRef<boolean | undefined>(undefined);
  const snapshots = useRuntimeSnapshots(runtimes);

  useEffect(() => {
    let mounted = true;
    const next = appearanceSections.map((descriptor) => ({
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
  }, [appearanceSections, changes, client, folder, layer]);

  useEffect(() => {
    if (!applyThemePreview || typeof document === "undefined") return;
    if (originalDarkClass.current === undefined) {
      originalDarkClass.current = document.documentElement.classList.contains("dark");
    }
    return () => {
      if (originalDarkClass.current !== undefined) {
        document.documentElement.classList.toggle("dark", originalDarkClass.current);
      }
    };
  }, [applyThemePreview]);

  const loaded =
    snapshots.length === appearanceSections.length &&
    snapshots.every((snapshot) => snapshot.config !== null);
  useEffect(() => {
    if (!applyThemePreview || !loaded || typeof document === "undefined") return;
    const themeKey = themePreview?.key ?? (browserPrefersDark() ? "theme.dark" : "theme.light");
    const themeName =
      themePreview?.value ??
      stringSetting(snapshots, themeKey, themeKey === "theme.dark" ? "titanium" : "light");
    const isDark = themeName === "titanium" || (themeName !== "light" && themeKey === "theme.dark");
    document.documentElement.classList.toggle("dark", isDark);
  }, [applyThemePreview, loaded, snapshots, themePreview]);

  const visibleDescriptors = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return appearanceSections;
    return appearanceSections.filter((descriptor) =>
      descriptor.controls.some((control) =>
        `${control.key} ${control.label} ${control.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      ),
    );
  }, [appearanceSections, search]);
  const selectedSectionId = visibleDescriptors.some(({ id }) => id === activeSectionId)
    ? activeSectionId
    : visibleDescriptors[0]?.id;
  const activeDescriptor = visibleDescriptors.find(({ id }) => id === selectedSectionId);
  const activeRuntime = runtimes.find(({ descriptor }) => descriptor.id === activeDescriptor?.id);
  const activeSnapshot = snapshots.find(({ descriptor }) => descriptor.id === activeDescriptor?.id);

  function currentSetting(key: string): JsonValue | undefined {
    return valueFromSections(snapshots, key);
  }

  function clearPreview(descriptor: SettingsSectionDescriptor): void {
    if (descriptor.id === THEME_SETTINGS_SECTION.id) setThemePreview(undefined);
    setActionError(undefined);
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
    if (
      applyThemePreview &&
      (key === "theme.dark" || key === "theme.light") &&
      typeof value === "string"
    ) {
      setThemePreview({ key, value });
    }
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
            conflictRows: activeSnapshot.conflict
              ? settingsConflictRows(
                  activeDescriptor,
                  activeSnapshot.conflict.remote,
                  activeSnapshot.conflict.changedKeys,
                )
              : [],
            applyStatus: activeSnapshot.applyStatus,
            error: activeSnapshot.error?.message,
            unsavedKeys: activeSnapshot.unsavedKeys,
            unsavedLabels: settingLabels(activeDescriptor, activeSnapshot.unsavedKeys),
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
    onThemeSelect: (value) => {
      if (selector?.kind === "theme") selectValue(selector.key, value);
    },
    onImagesSelect: (value) => selectValue("terminal.showImages", value),
    onCancelSelector: cancelSelector,
    onStage: (sectionId, staged) => {
      const section = runtimes.find(({ descriptor }) => descriptor.id === sectionId);
      if (!section) return;
      setActionError(undefined);
      stageNext(section.runtime, section.descriptor, staged);
    },
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
