import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModelDescriptor } from "../contract";
import {
  filterModels,
  groupModels,
  type ModelCatalogModel,
  modelKey,
  modelRefFromDescriptor,
  recentModels,
} from "../model/catalog";
import type { ModelRoleStore } from "../model/roles";

export interface ModelHubProps {
  readonly catalog: ModelCatalogModel;
  readonly roles?: ModelRoleStore;
  readonly onProviderLogin?: (provider: string) => void;
  readonly onProviderReopen?: (provider: string) => void;
  readonly title?: string;
}

type HubTab = "all" | "recent" | "roles";

function useCatalogSnapshot(catalog: ModelCatalogModel) {
  const subscribe = useCallback(
    (listener: Parameters<ModelCatalogModel["subscribe"]>[0]) => catalog.subscribe(listener),
    [catalog],
  );
  const getSnapshot = useCallback(() => catalog.getSnapshot(), [catalog]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useRoleSnapshot(roles: ModelRoleStore | undefined) {
  const subscribe = useCallback(
    (listener: Parameters<ModelRoleStore["subscribe"]>[0]) =>
      roles?.subscribe(listener) ?? (() => undefined),
    [roles],
  );
  const getSnapshot = useCallback(() => roles?.getSnapshot() ?? null, [roles]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function readableRoleSelector(
  selector: string | { readonly provider: string; readonly modelId: string },
): string {
  return typeof selector === "string" ? selector : modelKey(selector);
}

function HubModelRow({
  model,
  selected,
  current,
  onSelect,
  onLogin,
  onReopen,
}: {
  readonly model: ModelDescriptor;
  readonly selected: boolean;
  readonly current: boolean;
  readonly onSelect: () => void;
  readonly onLogin?: (provider: string) => void;
  readonly onReopen?: (provider: string) => void;
}) {
  if (model.availability === "locked") {
    const provider = model.loginProvider ?? model.provider;
    const action = onReopen ?? onLogin;
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{provider}</div>
          <div className="text-xs text-muted-foreground">Provider login is required.</div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!action}
          onClick={() => action?.(provider)}
        >
          {onReopen ? "Reopen" : "Log in"}
        </Button>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      className="h-auto w-full justify-start px-3 py-2 text-start"
      aria-pressed={selected}
      onClick={onSelect}
      disabled={model.availability === "unavailable"}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{model.name}</span>
          {current ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.7rem] text-primary">
              Current
            </span>
          ) : null}
        </span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          {modelKey(modelRefFromDescriptor(model))} · {model.reasoning ? "reasoning" : "general"}
        </span>
      </span>
    </Button>
  );
}

export function ModelHub({
  catalog,
  roles,
  onProviderLogin,
  onProviderReopen,
  title = "Model hub",
}: ModelHubProps) {
  const catalogSnapshot = useCatalogSnapshot(catalog);
  const roleSnapshot = useRoleSnapshot(roles);
  const [tab, setTab] = useState<HubTab>("all");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("balanced");
  const [roleName, setRoleName] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (catalogSnapshot.loadState !== "idle") return;
    void catalog.refresh().catch(() => undefined);
  }, [catalog, catalogSnapshot.loadState]);

  const filtered = useMemo(() => {
    const models =
      tab === "recent"
        ? recentModels(catalogSnapshot.models, catalog.getRecentKeys())
        : filterModels(catalogSnapshot.models, query);
    return filterModels(models, tab === "recent" ? query : "");
  }, [catalog, catalogSnapshot.models, query, tab]);
  const groups = useMemo(() => groupModels(filtered), [filtered]);
  const selected = filtered.find(
    (model) => modelKey(modelRefFromDescriptor(model)) === selectedKey,
  );
  const roleEntries = roleSnapshot ? Object.entries(roleSnapshot.settings.modelRoles) : [];

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The model hub operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const assignSelectedRole = () => {
    if (!roles || !selected) return;
    void run(() => roles.assignRole(roleName, modelKey(modelRefFromDescriptor(selected))));
  };

  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Search providers, assign roles, and choose whether changes apply to this session or
            saved default.
          </p>
        </div>
      </header>

      <div
        className="flex flex-wrap gap-1 border-b border-border/60 pb-2"
        role="tablist"
        aria-label="Model hub views"
      >
        {(["all", "recent", "roles"] as const).map((view) => (
          <Button
            key={view}
            type="button"
            size="sm"
            variant={tab === view ? "secondary" : "ghost"}
            role="tab"
            aria-selected={tab === view}
            onClick={() => setTab(view)}
          >
            {view === "all" ? "All models" : view === "recent" ? "Recent" : "Roles"}
          </Button>
        ))}
      </div>

      {tab !== "roles" ? (
        <>
          <Input
            aria-label="Search model hub"
            placeholder="Search models, providers or APIs"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            disabled={catalogSnapshot.loadState === "loading"}
          />
          <div className="flex max-h-80 min-h-20 flex-col gap-3 overflow-y-auto">
            {catalogSnapshot.loadState === "loading" ? (
              <p
                role="status"
                className="rounded-lg border border-border/70 px-3 py-4 text-sm text-muted-foreground"
              >
                Discovering models…
              </p>
            ) : catalogSnapshot.loadState === "error" ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 px-3 py-4 text-sm text-destructive"
              >
                {catalogSnapshot.error?.message ?? "Model discovery failed."}
              </p>
            ) : groups.length === 0 ? (
              <p className="rounded-lg border border-border/70 px-3 py-4 text-sm text-muted-foreground">
                No models match this search.
              </p>
            ) : (
              groups.map((group) => (
                <section
                  key={group.provider}
                  aria-label={`${group.provider} models`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>{group.provider}</span>
                    {group.locked ? (
                      <span>Login required</span>
                    ) : (
                      <span>{group.models.length} models</span>
                    )}
                  </div>
                  {group.models.map((model) => (
                    <HubModelRow
                      key={modelKey(modelRefFromDescriptor(model))}
                      model={model}
                      selected={selectedKey === modelKey(modelRefFromDescriptor(model))}
                      current={
                        catalogSnapshot.current?.provider === model.provider &&
                        catalogSnapshot.current.modelId === model.id
                      }
                      onSelect={() => setSelectedKey(modelKey(modelRefFromDescriptor(model)))}
                      onLogin={onProviderLogin}
                      onReopen={onProviderReopen}
                    />
                  ))}
                </section>
              ))
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selected || busy}
              onClick={() => {
                if (!selected) return;
                void run(() =>
                  catalog.apply({ model: modelRefFromDescriptor(selected), scope: "session" }),
                );
              }}
            >
              Apply to this session
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selected || !roles || busy}
              onClick={() => {
                if (!selected || !roles) return;
                void run(() =>
                  roles.assignRole("default", modelKey(modelRefFromDescriptor(selected))),
                );
              }}
            >
              Save as default
            </Button>
            <span className="flex items-center text-xs text-muted-foreground">
              {selected
                ? `Selected: ${modelKey(modelRefFromDescriptor(selected))}`
                : "Select a model first"}
            </span>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-2">
            <label htmlFor="d1-role-name" className="flex min-w-44 flex-1 flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Role name</span>
              <Input
                id="d1-role-name"
                value={roleName}
                onChange={(event) => setRoleName(event.currentTarget.value)}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!roles || !selected || busy}
              onClick={assignSelectedRole}
            >
              Assign selected model
            </Button>
          </div>
          {!roles ? (
            <p
              role="status"
              className="rounded-lg border border-border/70 px-3 py-4 text-sm text-muted-foreground"
            >
              Saved model sets are unavailable until omp's settings load.
            </p>
          ) : roleEntries.length === 0 ? (
            <p className="rounded-lg border border-border/70 px-3 py-4 text-sm text-muted-foreground">
              No roles assigned yet.
            </p>
          ) : (
            <section aria-label="Assigned model roles" className="flex flex-col gap-2">
              {roleEntries.map(([role, selector]) => (
                <div
                  key={role}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{role}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {readableRoleSelector(selector)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(() => roles.unassignRole(role))}
                  >
                    Unassign
                  </Button>
                </div>
              ))}
            </section>
          )}
          {roles ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
              <div>
                <h2 className="text-sm font-semibold">Fallback / cycle order</h2>
                <p className="text-xs text-muted-foreground">
                  The next role is used when cycling models; the order is saved with your settings.
                </p>
              </div>
              {roleSnapshot?.settings.cycleOrder.map((role, index, order) => (
                <div key={role} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {index + 1}. {role}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${role} up`}
                      disabled={index === 0 || busy}
                      onClick={() => void run(() => roles.moveCycleRole(role, -1))}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${role} down`}
                      disabled={index === order.length - 1 || busy}
                      onClick={() => void run(() => roles.moveCycleRole(role, 1))}
                    >
                      ↓
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {roles ? (
            <section
              aria-label="Saved model presets"
              className="flex flex-col gap-2 rounded-lg border border-border/70 p-3"
            >
              <div>
                <h2 className="text-sm font-semibold">Saved presets</h2>
                <p className="text-xs text-muted-foreground">
                  Saved for all workspaces or only for this workspace, as set in Settings.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label
                  htmlFor="d1-preset-name"
                  className="flex min-w-44 flex-1 flex-col gap-1 text-sm"
                >
                  <span className="text-xs text-muted-foreground">Preset name</span>
                  <Input
                    id="d1-preset-name"
                    value={presetName}
                    onChange={(event) => setPresetName(event.currentTarget.value)}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => roles.savePreset(presetName))}
                >
                  Save preset
                </Button>
              </div>
              {Object.keys(roleSnapshot?.settings.modelPresets ?? {}).length === 0 ? (
                <p className="text-xs text-muted-foreground">No saved presets.</p>
              ) : (
                Object.keys(roleSnapshot?.settings.modelPresets ?? {}).map((preset) => (
                  <div key={preset} className="flex items-center justify-between gap-2 text-sm">
                    <span>{preset}</span>
                    <span className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(() => roles.switchPreset(preset))}
                      >
                        Switch
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(() => roles.deletePreset(preset))}
                      >
                        Delete
                      </Button>
                    </span>
                  </div>
                ))
              )}
            </section>
          ) : null}
        </div>
      )}

      {roleSnapshot?.status === "conflict" ? (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
        >
          The saved roles changed elsewhere. Reloaded the latest roles; review before saving again.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
