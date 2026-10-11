import type { AppClient } from "@omp-app/client";
import type {
  CapabilityMap,
  ConfigWriteLayer,
  FolderPath,
  SettingTab,
  ThreadId,
} from "@omp-app/contracts";
import { SETTING_SECTIONS as OMP_SETTING_SECTIONS, SETTING_TABS } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  EmptyState,
  InlineError,
  ListRow,
  Panel,
  Section,
  SettingRow,
  Toolbar,
} from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSettingsSection } from "@/modules/D1/settings";
import {
  ContextSettings,
  type ContextSettingsScope,
  P7_CONTEXT_SETTINGS_SECTIONS,
} from "@/modules/P7/settings";
import type { BrowserPalette } from "@/modules/S1/appearance/preview";
import {
  createConfigChangeSource,
  createConfigStoreClient,
  createSettingsRuntime,
  type SettingsRuntime,
  useSettingsRuntime,
} from "@/modules/S1/runtime";
import {
  type AppearanceSettingsActions,
  AppearanceSettingsView,
  useAppearanceSettingsController,
} from "@/modules/S1/settings";
import {
  type ApplyStatus,
  environmentOverrideText,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  saveLocationText,
  settingLabels,
  UnsavedSettingsNotice,
  type ValidationResult,
} from "@/modules/S1/settings-kit";
import { SETTINGS_SECTIONS } from "@/registry";
import { DARK_QUERY, resolveTheme, useThemePreference } from "@/theme";
import { ExtensionCenterSection, extensionCenterAvailable } from "./extension-center-section";
import { ProviderLoginSection, providerLoginAvailable } from "./provider-login-section";
import { layerFolder } from "./settings-scope";

export type SettingsScreenProps = {
  readonly client: AppClient;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  readonly onClose: () => void;
  /** Told when the screen gains or loses unsaved edits, so closing can ask before it discards them. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  /** The open chat, whose omp session runs provider login; null when no chat is open. */
  readonly threadId: ThreadId | null;
  /** Starts a chat to sign in with, when no chat is open (Providers offers it); the chat's id is what opens sign-in. */
  readonly onStartChat?: () => Promise<void>;
};

type SettingsLayer = Extract<ConfigWriteLayer, "global" | "project">;
type SettingsGroups = Readonly<Record<SettingTab, readonly SettingsSectionDescriptor[]>>;

/** The tabs the screen has always opened with, in that order; the other omp tabs follow in omp's order. */
const LEADING_TABS: readonly SettingTab[] = ["appearance", "interaction", "model"];
const TAB_ORDER: readonly SettingTab[] = [
  ...LEADING_TABS,
  ...SETTING_TABS.filter((tab) => !LEADING_TABS.includes(tab)),
];
const TAB_LABELS: Readonly<Record<SettingTab, string>> = {
  appearance: "Appearance",
  interaction: "Interaction",
  model: "Model",
  context: "Context",
  memory: "Memory",
  files: "Files",
  shell: "Shell",
  tools: "Tools",
  tasks: "Tasks",
  providers: "Providers",
};
const TERMINAL_THEME_SECTION_ID = "S1.appearanceTheme";

function subscribeToSystemTheme(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function useAppPalette(): BrowserPalette {
  const preference = useThemePreference();
  const prefersDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark, () => false);
  return resolveTheme(preference, prefersDark);
}

function sectionParts(descriptor: SettingsSectionDescriptor): {
  readonly tab: string;
  readonly name: string;
} {
  const separator = descriptor.section.indexOf("/");
  return {
    tab: descriptor.section.slice(0, separator),
    name: descriptor.section.slice(separator + 1),
  };
}

/**
 * Whether a section matches a search (already trimmed and lower-cased): its title, omp's own name for it (so
 * "grep & browser" still finds "Grep and Browser"), or a control's label or description.
 */
export function sectionMatchesSearch(
  descriptor: SettingsSectionDescriptor,
  normalizedSearch: string,
): boolean {
  const searchable = [
    descriptor.title,
    sectionParts(descriptor).name,
    ...descriptor.controls.flatMap((control) => [control.label, control.description ?? ""]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(normalizedSearch);
}

function orderedSections(tab: SettingTab): readonly SettingsSectionDescriptor[] {
  return SETTINGS_SECTIONS.filter((descriptor) => sectionParts(descriptor).tab === tab).sort(
    (left, right) => {
      const order = OMP_SETTING_SECTIONS[tab];
      const leftPosition = order.indexOf(sectionParts(left).name);
      const rightPosition = order.indexOf(sectionParts(right).name);
      return leftPosition - rightPosition || left.title.localeCompare(right.title);
    },
  );
}

const SETTINGS_GROUPS: SettingsGroups = {
  appearance: orderedSections("appearance").filter(
    (descriptor) => descriptor.id !== TERMINAL_THEME_SECTION_ID,
  ),
  interaction: orderedSections("interaction"),
  model: orderedSections("model"),
  context: P7_CONTEXT_SETTINGS_SECTIONS,
  memory: orderedSections("memory"),
  files: orderedSections("files"),
  shell: orderedSections("shell"),
  tools: orderedSections("tools"),
  tasks: orderedSections("tasks"),
  providers: orderedSections("providers"),
};

function firstSection(
  tab: SettingTab,
  capabilities: CapabilityMap,
): SettingsSectionDescriptor | undefined {
  const sections = SETTINGS_GROUPS[tab];
  return (
    sections.find((descriptor) => unavailableReason(descriptor, capabilities) === undefined) ??
    sections[0]
  );
}

function unavailableReason(
  descriptor: SettingsSectionDescriptor,
  capabilities: CapabilityMap,
): string | undefined {
  const missing = descriptor.requires.find((key) => {
    const state = capabilities[key]?.state;
    return state !== "available" && state !== "fallback";
  });
  if (missing === undefined) return undefined;
  if (missing === "host.git") return "Git settings are unavailable for this workspace.";
  if (missing === "host.power") return "Power settings are unavailable on this device.";
  switch (capabilities[missing]?.via) {
    case "upstream":
      return "This setting needs a newer version of omp.";
    case "rpc":
      return "This setting is not supported by the connected omp process.";
    case "host":
      return "This setting is not available from the app host.";
    case "client":
      return "This setting is not available in this browser.";
    default:
      return "The current connection has not confirmed that this setting is available.";
  }
}

class SettingsRuntimePool {
  private readonly runtimes = new Map<string, SettingsRuntime>();
  private readonly client: AppClient;
  private readonly folder: FolderPath | null;

  public constructor(client: AppClient, folder: FolderPath | null) {
    this.client = client;
    this.folder = folder;
  }

  public get(descriptor: SettingsSectionDescriptor, layer: SettingsLayer): SettingsRuntime {
    const key = `${layer}:${descriptor.id}`;
    const cached = this.runtimes.get(key);
    if (cached) return cached;
    const runtime = createSettingsRuntime(this.client, {
      descriptor,
      folder: layerFolder(layer, this.folder),
      layer,
    });
    this.runtimes.set(key, runtime);
    return runtime;
  }

  public dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
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

function applyStatusLabel(status: ApplyStatus): string {
  switch (status) {
    case "session-only":
      return "This session only";
    case "reload-required":
      return "Reload required";
    case "restart-required":
      return "Restart required";
    case "unsupported":
      return "Unavailable";
    default:
      return "Applied";
  }
}

function phaseLabel(
  phase: ReturnType<SettingsRuntime["getSnapshot"]>["phase"],
): string | undefined {
  switch (phase) {
    case "loading":
      return "Loading settings…";
    case "saving":
      return "Saving changes…";
    case "conflict":
      return "Settings changed elsewhere";
    case "error":
      return "Settings unavailable";
    default:
      return undefined;
  }
}

function runtimeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function SettingsRuntimePanel({
  pool,
  descriptor,
  layer,
  onDirtyChange,
}: {
  readonly pool: SettingsRuntimePool;
  readonly descriptor: SettingsSectionDescriptor;
  readonly layer: SettingsLayer;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<SettingsRuntime | null>(null);
  useEffect(() => {
    setRuntime(pool.get(descriptor, layer));
  }, [descriptor, layer, pool]);

  if (runtime === null) {
    return (
      <EmptyState
        title="Preparing settings…"
        hint="Settings are read from omp."
        variant="compact"
      />
    );
  }
  return (
    <SettingsRuntimeEditor
      descriptor={descriptor}
      onDirtyChange={onDirtyChange}
      runtime={runtime}
    />
  );
}

function SettingsRuntimeEditor({
  descriptor,
  onDirtyChange,
  runtime,
}: {
  readonly descriptor: SettingsSectionDescriptor;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
  readonly runtime: SettingsRuntime;
}) {
  const snapshot = useSettingsRuntime(runtime);
  const [localValidation, setLocalValidation] = useState<
    Readonly<Record<string, ValidationResult>>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const staged = snapshot.staged;
  const dirty = staged !== null && Object.keys(staged.edits).length > 0;
  const unsavedLabels = settingLabels(descriptor, snapshot.unsavedKeys);

  useEffect(() => onDirtyChange(descriptor.id, dirty), [descriptor.id, dirty, onDirtyChange]);
  useEffect(() => {
    if (snapshot.phase !== "idle") return;
    void runtime.read().catch((error: unknown) => {
      setActionError(runtimeError(error, "Settings could not be loaded."));
    });
  }, [runtime, snapshot.phase]);

  const clearValidation = (key: string): void => {
    setLocalValidation((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const retry = async (): Promise<void> => {
    setActionError(null);
    try {
      await runtime.retry();
    } catch (error) {
      setActionError(runtimeError(error, "Settings could not be loaded."));
    }
  };
  const save = (): void => {
    setActionError(null);
    void runtime.save().catch((error: unknown) => {
      setActionError(runtimeError(error, "Settings could not be saved."));
    });
  };

  if (snapshot.config === null || staged === null) {
    const message = actionError ?? snapshot.error?.message;
    return message ? (
      <InlineError heading="Settings could not be loaded" message={message} onRetry={retry} />
    ) : (
      <EmptyState
        title={phaseLabel(snapshot.phase) ?? "Loading settings…"}
        hint="Settings are read from omp and saved to the selected location."
        variant="compact"
      />
    );
  }

  const disabled =
    snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "conflict";
  const applied = snapshot.applyStatus
    ? applyStatusLabel(snapshot.applyStatus)
    : phaseLabel(snapshot.phase);
  // A save that omp keeps overriding with the environment is not "Applied": the section states it in a sentence of its
  // own, which wraps on a narrow screen (the status pill does not), and the pill keeps only a status other than applied.
  const override = snapshot.environmentOverride;
  const notice = override === null ? undefined : environmentOverrideText(override);
  const status =
    notice === undefined
      ? applied
      : snapshot.applyStatus && snapshot.applyStatus !== "applied"
        ? applyStatusLabel(snapshot.applyStatus)
        : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsSection
        descriptor={descriptor}
        snapshot={snapshot.config}
        staged={staged}
        disabled={disabled}
        validation={{ ...snapshot.validation, ...localValidation }}
        applyStatus={status}
        notice={notice}
        unsavedKeys={snapshot.unsavedKeys}
        onStage={(next) => {
          for (const [key, value] of changedEdits(staged, next)) {
            const result = runtime.stage(key, value);
            if (result.ok) clearValidation(key);
            else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
          }
        }}
        onPreview={(key, result) => {
          if (result.ok) clearValidation(key);
          else setLocalValidation((current) => ({ ...current, [key]: result.validation }));
        }}
        onCommit={save}
        onCancel={() => {
          setActionError(null);
          setLocalValidation({});
          runtime.cancel();
        }}
      />
      {snapshot.conflict ? (
        <Section
          heading="Settings changed elsewhere"
          headingLevel={3}
          description="Another change arrived while this section was open. Reload the latest values or keep your edits and save again."
        >
          <Toolbar ariaLabel="Conflict actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => runtime.resolveConflict("reload")}
            >
              Reload latest
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => runtime.resolveConflict("keep-mine")}
            >
              Keep my edits
            </Button>
          </Toolbar>
        </Section>
      ) : null}
      {unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice
          labels={unsavedLabels}
          reason={actionError ?? snapshot.error?.message ?? ""}
        />
      ) : actionError || (snapshot.error && snapshot.phase !== "conflict") ? (
        <InlineError
          message={actionError ?? snapshot.error?.message ?? "Settings could not be saved."}
          onRetry={retry}
        />
      ) : null}
    </div>
  );
}

function ModelSettingsPanel({
  pool,
  descriptor,
  layer,
  onDirtyChange,
}: {
  readonly pool: SettingsRuntimePool;
  readonly descriptor: SettingsSectionDescriptor;
  readonly layer: SettingsLayer;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<SettingsRuntime | null>(null);
  useEffect(() => {
    setRuntime(pool.get(descriptor, layer));
  }, [descriptor, layer, pool]);
  if (runtime === null) {
    return (
      <EmptyState
        title="Preparing model settings…"
        hint="Settings are read from omp."
        variant="compact"
      />
    );
  }
  return (
    <ModelSettingsPanelReady
      descriptor={descriptor}
      onDirtyChange={onDirtyChange}
      runtime={runtime}
    />
  );
}

function ModelSettingsPanelReady({
  descriptor,
  onDirtyChange,
  runtime,
}: {
  readonly descriptor: SettingsSectionDescriptor;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
  readonly runtime: SettingsRuntime;
}) {
  const snapshot = useSettingsRuntime(runtime);
  const dirty = snapshot.staged !== null && Object.keys(snapshot.staged.edits).length > 0;
  useEffect(() => onDirtyChange(descriptor.id, dirty), [descriptor.id, dirty, onDirtyChange]);
  return <ModelSettingsSection descriptor={descriptor} runtime={runtime} />;
}

function AppearanceSettingsPanel({
  client,
  folder,
  layer,
  onClose,
  onDirtyChange,
  appearanceSections,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath | null;
  readonly layer: SettingsLayer;
  readonly onClose: () => void;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
  readonly appearanceSections: readonly SettingsSectionDescriptor[];
}) {
  const configClient = useMemo(() => createConfigStoreClient(client), [client]);
  const scopeFolder = layerFolder(layer, folder);
  const changes = useMemo(
    () => createConfigChangeSource(client, scopeFolder),
    [client, scopeFolder],
  );
  const previewPalette = useAppPalette();
  const { model, actions } = useAppearanceSettingsController({
    appearanceSections,
    applyThemePreview: false,
    client: configClient,
    changes,
    folder: scopeFolder,
    initialSectionId: appearanceSections[0]?.id,
    layer,
    previewPalette,
  });
  useEffect(() => {
    const active = model.activeSection;
    if (active) {
      onDirtyChange(active.descriptor.id, Object.keys(active.staged.edits).length > 0);
    }
  }, [model.activeSection, onDirtyChange]);
  const trackedActions: AppearanceSettingsActions = {
    ...actions,
    onStage: (sectionId, staged) => {
      actions.onStage(sectionId, staged);
      onDirtyChange(sectionId, Object.keys(staged.edits).length > 0);
    },
    onCancel: (sectionId) => {
      actions.onCancel(sectionId);
      onDirtyChange(sectionId, false);
    },
  };
  return (
    <AppearanceSettingsView
      model={model}
      actions={trackedActions}
      onClose={onClose}
      showHeader={false}
    />
  );
}

export function SettingsScreen({
  client,
  capabilities,
  folder,
  onClose,
  onUnsavedChange,
  threadId,
  onStartChat,
}: SettingsScreenProps) {
  const [activeTab, setActiveTab] = useState<SettingTab>("appearance");
  const [layer, setLayer] = useState<SettingsLayer>("global");
  const [search, setSearch] = useState("");
  const [selectedSections, setSelectedSections] = useState<Partial<Record<SettingTab, string>>>(
    () => ({
      interaction: firstSection("interaction", capabilities)?.id,
      model: firstSection("model", capabilities)?.id,
    }),
  );
  const [dirtySections, setDirtySections] = useState<ReadonlySet<string>>(() => new Set());
  const pool = useMemo(() => new SettingsRuntimePool(client, folder), [client, folder]);
  useEffect(() => () => pool.dispose(), [pool]);
  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setDirtySections((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const configStatus = capabilities["host.config"]?.state;
  const configAvailable = configStatus === "available" || configStatus === "fallback";
  // A section the host or omp cannot serve is left out, not listed disabled.
  const sections = useMemo(
    () =>
      SETTINGS_GROUPS[activeTab].filter(
        (descriptor) => unavailableReason(descriptor, capabilities) === undefined,
      ),
    [activeTab, capabilities],
  );
  // The tabs with a section to show. A tab whose sections are all unavailable is left out.
  const shownTabs = TAB_ORDER.filter((tab) =>
    SETTINGS_GROUPS[tab].some(
      (descriptor) => unavailableReason(descriptor, capabilities) === undefined,
    ),
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleSections = useMemo(() => {
    if (normalizedSearch.length === 0) return sections;
    return sections.filter((descriptor) => sectionMatchesSearch(descriptor, normalizedSearch));
  }, [normalizedSearch, sections]);
  const selectedId = selectedSections[activeTab];
  const activeSection =
    visibleSections.find((section) => section.id === selectedId) ?? visibleSections[0];
  const hasDirtySections = dirtySections.size > 0;
  // Tells the overlay whether closing now would lose edits, so an outside press can ask first. The last
  // value sent is remembered, so a new callback on each render does not send the same value again.
  const reportedUnsaved = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (reportedUnsaved.current === hasDirtySections) return;
    reportedUnsaved.current = hasDirtySections;
    onUnsavedChange?.(hasDirtySections);
  }, [hasDirtySections, onUnsavedChange]);

  const selectTab = (tab: SettingTab): void => {
    setActiveTab(tab);
    setSearch("");
  };
  const selectSection = (descriptor: SettingsSectionDescriptor): void => {
    setSelectedSections((current) => ({ ...current, [activeTab]: descriptor.id }));
  };
  const changeLayer = (next: SettingsLayer): void => {
    if (hasDirtySections || (next === "project" && folder === null)) return;
    setLayer(next);
  };

  const closeButton = (
    <Button aria-label="Close settings" type="button" size="sm" variant="outline" onClick={onClose}>
      Close
    </Button>
  );
  const configUnavailable = !configAvailable;
  const appearance = (
    <div hidden={activeTab !== "appearance"}>
      <AppearanceSettingsPanel
        appearanceSections={SETTINGS_GROUPS.appearance}
        client={client}
        folder={folder}
        layer={layer}
        onClose={onClose}
        onDirtyChange={reportDirty}
      />
    </div>
  );
  // The Context view keeps its staged edits while another tab is open, as Appearance does.
  const contextScope: ContextSettingsScope =
    layer === "project" && folder !== null ? { layer: "project", folder } : { layer: "global" };
  const context = (
    <div hidden={activeTab !== "context"}>
      <ContextSettings
        client={client}
        onDirtyChange={(dirty) => reportDirty("P7.context", dirty)}
        scope={contextScope}
        showHeader={false}
      />
    </div>
  );

  return (
    <Panel
      title="Settings"
      description="omp's settings, by tab."
      actions={closeButton}
      className="max-h-[80dvh] min-w-0"
      rootProps={{ "data-testid": "settings-screen" }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <SettingRow
          title="Save settings to"
          description={
            hasDirtySections
              ? "Save or cancel staged changes before changing where they are saved."
              : "Choose whether changes apply to all workspaces or only this workspace."
          }
          detail={saveLocationText(layer)}
          layout="stacked"
        >
          <Toolbar ariaLabel="Save settings to">
            <Button
              type="button"
              size="sm"
              variant={layer === "global" ? "default" : "outline"}
              aria-pressed={layer === "global"}
              disabled={hasDirtySections}
              onClick={() => changeLayer("global")}
            >
              All workspaces
            </Button>
            <Button
              type="button"
              size="sm"
              variant={layer === "project" ? "default" : "outline"}
              aria-pressed={layer === "project"}
              disabled={folder === null || hasDirtySections}
              title={folder === null ? "Choose a workspace folder first." : undefined}
              onClick={() => changeLayer("project")}
            >
              This workspace
            </Button>
          </Toolbar>
        </SettingRow>
        <Toolbar ariaLabel="Settings categories">
          {shownTabs.map((tab) => (
            <Button
              key={tab}
              type="button"
              size="sm"
              variant={activeTab === tab ? "default" : "outline"}
              aria-pressed={activeTab === tab}
              onClick={() => selectTab(tab)}
            >
              {TAB_LABELS[tab]}
            </Button>
          ))}
        </Toolbar>
        {configUnavailable ? (
          <InlineError
            heading="Settings unavailable"
            message="This connection cannot read or save settings."
          />
        ) : (
          <>
            {appearance}
            {shownTabs.includes("context") ? context : null}
            {activeTab !== "appearance" && activeTab !== "context" ? (
              <div className="flex min-w-0 flex-col gap-4">
                {activeTab === "tools" && extensionCenterAvailable(capabilities) ? (
                  <ExtensionCenterSection
                    capabilities={capabilities}
                    client={client}
                    folder={folder}
                  />
                ) : null}
                {activeTab === "providers" && providerLoginAvailable(capabilities) ? (
                  <ProviderLoginSection
                    capabilities={capabilities}
                    client={client}
                    threadId={threadId}
                    onStartChat={onStartChat}
                  />
                ) : null}
                <Section heading={`${TAB_LABELS[activeTab]} sections`} variant="plain">
                  <div className="mb-2 flex flex-col gap-1 text-sm font-medium">
                    <label htmlFor="settings-section-search">Search sections</label>
                    <Input
                      id="settings-section-search"
                      type="search"
                      value={search}
                      placeholder="Search settings"
                      onChange={(event) => setSearch(event.currentTarget.value)}
                    />
                  </div>
                  {visibleSections.length === 0 ? (
                    <EmptyState title="No settings match this search." variant="compact" />
                  ) : (
                    <div role="listbox" aria-label={`${TAB_LABELS[activeTab]} settings sections`}>
                      {visibleSections.map((descriptor) => {
                        return (
                          <ListRow
                            key={descriptor.id}
                            title={descriptor.title}
                            selected={activeSection?.id === descriptor.id}
                            onSelect={() => selectSection(descriptor)}
                          />
                        );
                      })}
                    </div>
                  )}
                </Section>
                <section className="min-w-0" aria-label={`${TAB_LABELS[activeTab]} settings`}>
                  {!activeSection ? (
                    <EmptyState
                      title="No settings are available in this group."
                      variant="compact"
                    />
                  ) : activeTab === "model" ? (
                    <ModelSettingsPanel
                      key={`${layer}:${activeSection.id}`}
                      descriptor={activeSection}
                      layer={layer}
                      onDirtyChange={reportDirty}
                      pool={pool}
                    />
                  ) : (
                    <SettingsRuntimePanel
                      key={`${layer}:${activeSection.id}`}
                      descriptor={activeSection}
                      layer={layer}
                      onDirtyChange={reportDirty}
                      pool={pool}
                    />
                  )}
                </section>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
