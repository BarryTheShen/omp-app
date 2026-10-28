import type { AppClient } from "@omp-app/client";
import type {
  CapabilityMap,
  ConfigWriteLayer,
  FolderPath,
  SettingTab,
  ThreadId,
} from "@omp-app/contracts";
import { SETTING_SECTIONS as OMP_SETTING_SECTIONS, SETTING_TABS } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { STREAM_SETTINGS_SECTION } from "@/modules/I4/settings/stream-descriptor";
import { StreamSettings } from "@/modules/I4/settings/stream-settings";
import {
  ContextSettings,
  type ContextSettingsScope,
  P7_CONTEXT_SETTINGS_SECTIONS,
} from "@/modules/P7/settings";
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
import { type SettingsSectionDescriptor, saveLocationText } from "@/modules/S1/settings-kit";
import { RuntimeSettingsSection } from "@/modules/S2/lsp";
import { SETTINGS_SECTIONS } from "@/registry";
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

/**
 * The pages whose settings change the app. They come first, in this order, and Settings opens on the first one this
 * connection can use. The other omp pages follow in omp's order.
 */
const LEADING_TABS: readonly SettingTab[] = ["interaction", "model"];
/** Omp's terminal-only page: its settings change only omp's terminal, so it comes after the app's own pages. */
const TERMINAL_ONLY_TABS: readonly SettingTab[] = ["appearance"];
const TAB_ORDER: readonly SettingTab[] = [
  ...LEADING_TABS,
  ...SETTING_TABS.filter((tab) => !LEADING_TABS.includes(tab) && !TERMINAL_ONLY_TABS.includes(tab)),
  ...TERMINAL_ONLY_TABS,
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
  switch (capabilities[missing]?.via) {
    case "upstream":
      return "This setting needs a newer version of omp.";
    case "omp":
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
  const { model, actions } = useAppearanceSettingsController({
    appearanceSections,
    applyThemePreview: false,
    client: configClient,
    changes,
    folder: scopeFolder,
    initialSectionId: appearanceSections[0]?.id,
    layer,
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
  const [contextVisited, setContextVisited] = useState(false);
  // A tab without any available section is left out. Settings opens on the first tab that is shown.
  const shownTabs = TAB_ORDER.filter((tab) =>
    SETTINGS_GROUPS[tab].some(
      (descriptor) => unavailableReason(descriptor, capabilities) === undefined,
    ),
  );
  const [activeTab, setActiveTab] = useState<SettingTab>(() => shownTabs[0] ?? "interaction");
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
  // Keep unavailable settings visible in the section list so their reason is clear, but do not let them open an editor.
  const sections = useMemo(() => SETTINGS_GROUPS[activeTab], [activeTab]);
  const contextAvailable = shownTabs.includes("context");
  useEffect(() => {
    if (!contextAvailable || contextVisited) return undefined;
    if (typeof window.requestIdleCallback === "function") {
      const idleHandle = window.requestIdleCallback(() => setContextVisited(true), {
        timeout: 100,
      });
      return () => window.cancelIdleCallback(idleHandle);
    }
    const timeoutHandle = window.setTimeout(() => setContextVisited(true), 0);
    return () => window.clearTimeout(timeoutHandle);
  }, [contextAvailable, contextVisited]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleSections = useMemo(() => {
    if (normalizedSearch.length === 0) return sections;
    return sections.filter((descriptor) => sectionMatchesSearch(descriptor, normalizedSearch));
  }, [normalizedSearch, sections]);
  const selectedId = selectedSections[activeTab];
  const activeSection =
    visibleSections.find(
      (section) =>
        section.id === selectedId && unavailableReason(section, capabilities) === undefined,
    ) ?? visibleSections.find((section) => unavailableReason(section, capabilities) === undefined);
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
    if (tab === "context") setContextVisited(true);
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
    <Button
      aria-label="Close settings"
      className="h-8 rounded-control text-sm"
      type="button"
      size="sm"
      variant="outline"
      onClick={onClose}
    >
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
      className="max-h-[80dvh] min-w-0 [&>header]:border-foreground/10 [&>header]:px-4 [&>header>div>h2]:!font-medium [&>header>div>p]:!text-sm"
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
              className="h-8 rounded-control border-0 bg-transparent px-3 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground"
              size="sm"
              variant={layer === "global" ? "default" : "outline"}
              aria-pressed={layer === "global"}
              disabled={hasDirtySections}
              onClick={() => changeLayer("global")}
            >
              All workspaces
            </Button>
            <Button
              className="h-8 rounded-control border-0 bg-transparent px-3 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground"
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
              variant="outline"
              aria-pressed={activeTab === tab}
              className="h-8 rounded-control border-0 bg-transparent px-3 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground"
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
            {contextAvailable && (contextVisited || activeTab === "context") ? context : null}
            {activeTab !== "appearance" && activeTab !== "context" ? (
              <div className="flex min-w-0 flex-col gap-4">
                {activeTab === "tools" && extensionCenterAvailable(capabilities) ? (
                  <ExtensionCenterSection
                    capabilities={capabilities}
                    client={client}
                    folder={folder}
                    threadId={threadId}
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
                      className="rounded-control text-sm"
                      placeholder="Search settings"
                      onChange={(event) => setSearch(event.currentTarget.value)}
                    />
                  </div>
                  {visibleSections.length === 0 ? (
                    <EmptyState title="No settings match this search." variant="compact" />
                  ) : (
                    <div role="listbox" aria-label={`${TAB_LABELS[activeTab]} settings sections`}>
                      {visibleSections.map((descriptor) => {
                        const reason = unavailableReason(descriptor, capabilities);
                        return (
                          <ListRow
                            key={descriptor.id}
                            title={descriptor.title}
                            detail={reason}
                            disabled={reason !== undefined}
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
                  ) : activeSection.id === STREAM_SETTINGS_SECTION.id ? (
                    // omp stores the redaction patterns as strings; StreamSettings edits them as rows and maps back.
                    <StreamSettings
                      key={`${layer}:${activeSection.id}`}
                      runtime={pool.get(activeSection, layer)}
                      onDirtyChange={(dirty) => reportDirty(activeSection.id, dirty)}
                    />
                  ) : (
                    <RuntimeSettingsSection
                      key={`${layer}:${activeSection.id}`}
                      runtime={pool.get(activeSection, layer)}
                      onDirtyChange={(dirty) => reportDirty(activeSection.id, dirty)}
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
