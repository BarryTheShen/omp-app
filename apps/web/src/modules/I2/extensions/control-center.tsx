import type { CapabilityMap, FolderPath } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelShell } from "@/modules/U5/panel/shell";
import { useMediaQuery } from "@/shell/use-media-query";
import { Icons } from "@/tokens";
import type {
  ExtensionCatalog,
  ExtensionCatalogSnapshot,
  ExtensionMetadata,
  PromptMetadata,
} from "../catalog";
import { I2CapabilityKeys, isI2CapabilityAvailable } from "../catalog";
import { itemOriginText } from "./item-origin";

type ProviderTab = "extensions" | "skills" | "prompts" | "plugins";
type ControlItem = ExtensionMetadata | PromptMetadata;

const TABS: readonly { readonly id: ProviderTab; readonly label: string }[] = [
  { id: "extensions", label: "Extensions" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
  { id: "plugins", label: "Plugins" },
];

/** What an empty tab says in its own words; a search that finds nothing says "No matching ..." instead. */
const EMPTY_TAB_TEXT: Readonly<
  Record<ProviderTab, { readonly empty: string; readonly noMatch: string }>
> = {
  extensions: { empty: "No extensions installed.", noMatch: "No matching extensions." },
  skills: { empty: "No skills found.", noMatch: "No matching skills." },
  prompts: { empty: "No prompts found.", noMatch: "No matching prompts." },
  plugins: { empty: "No plugins installed.", noMatch: "No matching plugins." },
};

interface CatalogState {
  readonly status: "loading" | "ready" | "error" | "unavailable";
  readonly snapshot: ExtensionCatalogSnapshot | null;
  readonly error: AppFailure | null;
}

export interface ExtensionControlCenterProps {
  readonly catalog: ExtensionCatalog;
  readonly folder: FolderPath | null;
  readonly capabilities?: CapabilityMap;
}

function unavailableError(): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: "The extension catalog is unavailable for this runtime.",
    retryable: false,
    capability: I2CapabilityKeys.extensionCatalog,
  });
}

function itemId(item: ControlItem): string {
  return "id" in item ? item.id : `prompt:${item.provider}:${item.name}`;
}

/**
 * The key of each row in its tab. omp keeps two copies of one plugin or skill under one id (the earlier one is marked
 * shadowed), so an id alone is not unique: a copy whose id is shared gets its relative path, and copies that still
 * match get their place among them. Keys come from the whole tab, not from the search results, so a search does not
 * change which copy a row is.
 */
function rowKeysOf(list: readonly ControlItem[]): ReadonlyMap<ControlItem, string> {
  const copies = new Map<string, number>();
  for (const item of list) copies.set(itemId(item), (copies.get(itemId(item)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const keys = new Map<ControlItem, string>();
  for (const item of list) {
    const id = itemId(item);
    const base = (copies.get(id) ?? 0) > 1 ? `${id}|${item.path ?? ""}` : id;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    keys.set(item, count === 1 ? base : `${base}#${count}`);
  }
  return keys;
}

function itemName(item: ControlItem): string {
  return item.name;
}

function tabItems(snapshot: ExtensionCatalogSnapshot, tab: ProviderTab): readonly ControlItem[] {
  switch (tab) {
    case "skills":
      return snapshot.skills;
    case "prompts":
      return snapshot.prompts;
    case "plugins":
      return snapshot.extensions.filter((item) => item.source === "plugin");
    default:
      return snapshot.extensions.filter((item) => item.source === "extension");
  }
}

/** The number a tab names: the prompts it lists, or the items its sources total. Undefined until a snapshot was read. */
function tabCount(snapshot: ExtensionCatalogSnapshot | null, tab: ProviderTab): number | undefined {
  if (snapshot === null) return undefined;
  if (tab === "prompts") return snapshot.prompts.length;
  const source = tab === "skills" ? "skill" : tab === "plugins" ? "plugin" : "extension";
  return snapshot.sources
    .filter((item) => item.source === source)
    .reduce((sum, item) => sum + item.total, 0);
}

function securityLabel(item: ControlItem): string {
  if ("shadowed" in item && item.shadowed) return "Shadowed";
  if (!item.enabled) return "Disabled";
  return "Enabled";
}

function copyDetails(item: ControlItem, duplicateName: boolean): string | undefined {
  const details: string[] = [];
  if ("shadowed" in item && item.shadowed) details.push("Shadowed");
  if (duplicateName && "version" in item && item.version) details.push(item.version);
  return details.length === 0 ? undefined : details.join(" · ");
}

export function ExtensionControlCenter({
  catalog,
  folder,
  capabilities = {},
}: ExtensionControlCenterProps) {
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
    snapshot: null,
    error: null,
  });
  const [tab, setTab] = useState<ProviderTab>("extensions");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const available = isI2CapabilityAvailable(capabilities, I2CapabilityKeys.extensionCatalog);
  const narrow = useMediaQuery("(max-width: 48rem)");
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const inspectorHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    if (!available) {
      setCatalogState({ status: "unavailable", snapshot: null, error: unavailableError() });
      return;
    }
    setCatalogState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const snapshot = await catalog.list(folder);
      setCatalogState({ status: "ready", snapshot, error: null });
    } catch (error) {
      setCatalogState({
        status: "error",
        snapshot: null,
        error:
          error instanceof AppFailure
            ? error
            : new AppFailure({
                code: "internal",
                message: "Loading extensions failed.",
                retryable: true,
              }),
      });
    }
  }, [available, catalog, folder]);

  useEffect(() => {
    let active = true;
    void load();
    let unsubscribe: (() => Promise<void>) | undefined;
    void catalog
      .subscribe((change) => {
        if (!active) return;
        void load();
        void change;
      })
      .then((dispose) => {
        unsubscribe = dispose;
        if (!active) void dispose();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      void unsubscribe?.();
    };
  }, [catalog, load]);

  const reload = async (): Promise<void> => {
    if (!available) {
      setCatalogState({ status: "unavailable", snapshot: null, error: unavailableError() });
      return;
    }
    setReloading(true);
    try {
      const snapshot = await catalog.reload(folder);
      setCatalogState({ status: "ready", snapshot, error: null });
    } catch (error) {
      setCatalogState({
        status: "error",
        snapshot: catalogState.snapshot,
        error:
          error instanceof AppFailure
            ? error
            : new AppFailure({
                code: "internal",
                message: "Reloading extensions failed.",
                retryable: true,
              }),
      });
    } finally {
      setReloading(false);
    }
  };

  const items = useMemo(() => {
    if (!catalogState.snapshot) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return tabItems(catalogState.snapshot, tab).filter((item) => {
      if (normalized.length === 0) return true;
      return `${itemName(item)} ${itemOriginText(item)} ${item.description ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [catalogState.snapshot, query, tab]);

  const rowKeys = useMemo(
    () => rowKeysOf(catalogState.snapshot ? tabItems(catalogState.snapshot, tab) : []),
    [catalogState.snapshot, tab],
  );
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of catalogState.snapshot ? tabItems(catalogState.snapshot, tab) : []) {
      counts.set(itemName(item), (counts.get(itemName(item)) ?? 0) + 1);
    }
    return counts;
  }, [catalogState.snapshot, tab]);
  const keyOf = (item: ControlItem): string => rowKeys.get(item) ?? itemId(item);
  const selected =
    selectedId === null ? null : (items.find((item) => keyOf(item) === selectedId) ?? null);
  useEffect(() => {
    if (!narrow || selected === null) return;
    requestAnimationFrame(() => inspectorHeadingRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSelectedId(null);
      requestAnimationFrame(() => selectedButtonRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [narrow, selected]);
  const unavailable = catalogState.status === "unavailable";
  const lifecycle = unavailable
    ? "populated"
    : catalogState.status === "loading"
      ? "loading"
      : catalogState.status === "error"
        ? "error"
        : items.length === 0
          ? "empty"
          : "populated";

  return (
    <PanelShell
      body={
        <section
          className="flex min-h-0 flex-col gap-3"
          data-testid="extension-control-center"
          aria-label="Extension Control Center content"
          onKeyDown={(event) => {
            if (!narrow || selected === null || event.key !== "Escape") return;
            event.preventDefault();
            setSelectedId(null);
            requestAnimationFrame(() => selectedButtonRef.current?.focus());
          }}
        >
          {unavailable ? (
            <div className="py-6 text-sm" data-testid="extension-unavailable" role="status">
              <p className="font-medium text-foreground">Extensions unavailable</p>
              <p className="text-muted-foreground mt-1">
                {catalogState.error?.appError.message ?? "The host capability is unavailable."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Extension providers">
                {TABS.map((entry) => {
                  const count = tabCount(catalogState.snapshot, entry.id);
                  return (
                    <Button
                      aria-label={
                        count === undefined
                          ? entry.label
                          : `${entry.label}, ${count} ${count === 1 ? "item" : "items"}`
                      }
                      data-testid={`extension-tab-${entry.id}`}
                      key={entry.id}
                      role="tab"
                      aria-selected={tab === entry.id}
                      size="sm"
                      type="button"
                      variant={tab === entry.id ? "secondary" : "ghost"}
                      onClick={() => {
                        setTab(entry.id);
                        setSelectedId(null);
                      }}
                    >
                      {entry.label}
                      {count !== undefined && (
                        <span
                          aria-hidden="true"
                          className="bg-muted text-muted-foreground ms-1 rounded-full px-1.5 py-0.5 text-xs"
                        >
                          {count}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Input
                  aria-label="Search extensions"
                  placeholder="Search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                <Button
                  aria-label="Reload extension catalog"
                  disabled={reloading || !available}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                  onClick={() => void reload()}
                >
                  <Icons.undo aria-hidden="true" />
                </Button>
              </div>
              {catalogState.status === "loading" && (
                <p className="text-muted-foreground text-sm" role="status">
                  Loading extension catalog…
                </p>
              )}
              {catalogState.status === "ready" && items.length === 0 && (
                <p className="text-muted-foreground text-sm" role="status">
                  {query.trim().length > 0
                    ? EMPTY_TAB_TEXT[tab].noMatch
                    : EMPTY_TAB_TEXT[tab].empty}
                </p>
              )}
              <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.2fr)]">
                {(!narrow || selected === null) && (
                  <ul aria-label={`${tab} results`} className="min-h-0 space-y-1 overflow-auto">
                    {items.map((item) => {
                      const details = copyDetails(item, (nameCounts.get(itemName(item)) ?? 0) > 1);
                      return (
                        <li key={keyOf(item)}>
                          <button
                            ref={(node) => {
                              if (keyOf(item) === selectedId) selectedButtonRef.current = node;
                            }}
                            className={`border-border flex w-full min-w-0 flex-col rounded-md border px-2 py-2 text-start text-sm ${selected === item ? "bg-accent" : "bg-background"}`}
                            data-testid={`extension-item-${keyOf(item)}`}
                            type="button"
                            onClick={() => setSelectedId(keyOf(item))}
                          >
                            <span className="truncate font-medium">{itemName(item)}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {itemOriginText(item)}
                            </span>
                            {details !== undefined && (
                              <span className="truncate text-xs text-muted-foreground">
                                {details}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {(!narrow || selected !== null) && (
                  <div className="min-w-0">
                    <Inspector
                      headingRef={inspectorHeadingRef}
                      item={selected}
                      narrow={narrow}
                      onBack={() => {
                        setSelectedId(null);
                        requestAnimationFrame(() => selectedButtonRef.current?.focus());
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      }
      state={{
        open: true,
        lifecycle,
        position: "right",
        title: "Extension Control Center",
        description: "Extensions, skills, prompts and plugins",
        error: catalogState.error?.appError ?? null,
        readOnly: true,
        pendingUpdates: 0,
      }}
    />
  );
}

function Inspector({
  headingRef,
  item,
  narrow,
  onBack,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly item: ControlItem | null;
  readonly narrow: boolean;
  readonly onBack: () => void;
}) {
  if (!item)
    return (
      <div className="border-border rounded-lg border p-3 text-sm text-muted-foreground">
        Select an item to see its details.
      </div>
    );
  return (
    <article
      aria-label={`${itemName(item)} details`}
      className="border-border min-w-0 rounded-lg border p-3 text-sm"
      data-testid="extension-inspector"
    >
      {narrow && (
        <Button className="mb-3" size="sm" type="button" variant="ghost" onClick={onBack}>
          <Icons.chevronLeft aria-hidden="true" />
          Back
        </Button>
      )}
      <div className="flex items-start justify-between gap-2">
        <h3 ref={headingRef} className="break-words font-semibold" tabIndex={-1}>
          {itemName(item)}
        </h3>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
          {securityLabel(item)}
        </span>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Where it comes from</dt>
          <dd>{itemOriginText(item)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Provider</dt>
          <dd>{item.provider}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{item.source}</dd>
        </div>
        {"version" in item && item.version && (
          <div>
            <dt className="text-muted-foreground">Version</dt>
            <dd>{item.version}</dd>
          </div>
        )}
        {item.description && (
          <div>
            <dt className="text-muted-foreground">Description</dt>
            <dd className="break-words whitespace-pre-wrap">{item.description}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
