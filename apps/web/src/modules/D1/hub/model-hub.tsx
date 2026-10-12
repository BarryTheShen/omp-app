import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { EmptyState, InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInLabel } from "@/modules/D3/auth/sign-in";
import type { ModelDescriptor } from "../contract";
import type {
  HubAssignment,
  HubModelRow,
  HubRoleRow,
  HubScope,
  ModelHubViewModel,
} from "./model-hub-controller";

/** What the dialog's controls do. Each call is handled by the controller; this view holds no logic. */
export interface ModelHubActions {
  readonly selectScope: (scope: HubScope) => void;
  readonly setQuery: (query: string) => void;
  readonly setSessionModel: (model: ModelDescriptor) => void;
  readonly startRoleAssignment: (roleId: string) => void;
  readonly startModelAssignment: (key: string) => void;
  readonly cancelAssignment: () => void;
  readonly chooseModel: (model: ModelDescriptor) => void;
  readonly chooseRole: (roleId: string) => void;
  readonly clearRole: (roleId: string) => void;
  readonly moveCycleRole: (roleId: string, direction: -1 | 1) => void;
  readonly savePreset: (name: string) => void;
  readonly switchPreset: (name: string) => void;
  readonly deletePreset: (name: string) => void;
  readonly refreshModels: () => void;
  readonly dismissNotice: () => void;
}

/** Where focus goes after an action, so keyboard users are not left on a control that just went away. */
type RequestFocus = (key: string) => void;

interface PaneProps {
  readonly view: ModelHubViewModel;
  readonly actions: ModelHubActions;
  readonly requestFocus: RequestFocus;
}

const SEARCH = "search";
const PRESET_NAME = "preset-name";
const SCOPE_ROLES = "scope:roles";

function rowFocusKey(key: string): string {
  return `model-row:${key}`;
}

function roleChooseKey(roleId: string): string {
  return `role-choose:${roleId}`;
}

function rolePickKey(roleId: string): string {
  return `role-pick:${roleId}`;
}

function cycleKey(direction: -1 | 1, roleId: string): string {
  return `cycle-${direction < 0 ? "up" : "down"}:${roleId}`;
}

function presetSwitchKey(name: string): string {
  return `preset-switch:${name}`;
}

/** The element with this focus key inside `root`, when it is there and can take focus. */
function findFocusTarget(root: HTMLElement | null, key: string): HTMLElement | null {
  if (root === null) return null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-focus-key]")) {
    if (element.dataset.focusKey === key && !element.matches(":disabled")) return element;
  }
  return null;
}

/** The key the arrow, Home or End key moves to from `current` in `keys`; null for any other key. */
function neighbourKey(key: string, keys: readonly string[], current: string): string | null {
  const index = keys.indexOf(current);
  if (keys.length === 0 || index < 0) return null;
  if (key === "ArrowDown") return keys[(index + 1) % keys.length] ?? null;
  if (key === "ArrowUp") return keys[(index - 1 + keys.length) % keys.length] ?? null;
  if (key === "Home") return keys[0] ?? null;
  if (key === "End") return keys[keys.length - 1] ?? null;
  return null;
}

function modelDetail(model: ModelDescriptor, key: string): string {
  const context = model.contextWindow
    ? `${Math.round(model.contextWindow / 1_000)}k context`
    : "context unknown";
  return `${key} · ${model.reasoning ? "reasoning" : "general"} · ${context}`;
}

function ScopeButton({
  label,
  count,
  active,
  focusKey,
  onSelect,
}: {
  readonly label: string;
  readonly count: string | number;
  readonly active: boolean;
  readonly focusKey?: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-pressed={active}
      data-focus-key={focusKey}
      onClick={onSelect}
      className="h-auto min-w-0 justify-between gap-2 px-2.5 py-1.5 text-start"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
    </Button>
  );
}

function Sidebar({
  view,
  actions,
}: {
  readonly view: ModelHubViewModel;
  readonly actions: ModelHubActions;
}) {
  const scope = view.scope;
  return (
    <nav
      aria-label="Model lists"
      className="flex shrink-0 flex-wrap gap-1 sm:w-52 sm:flex-col sm:overflow-y-auto"
    >
      <ScopeButton
        label="Roles"
        count={`${view.roles.assignedCount}/${view.roles.rows.length}`}
        active={scope.kind === "roles"}
        focusKey={SCOPE_ROLES}
        onSelect={() => actions.selectScope({ kind: "roles" })}
      />
      <ScopeButton
        label="All models"
        count={view.modelCount}
        active={scope.kind === "all"}
        onSelect={() => actions.selectScope({ kind: "all" })}
      />
      {view.providers.length > 0 ? <hr className="my-1 hidden border-border/70 sm:block" /> : null}
      {view.providers.map(({ provider, count }) => (
        <ScopeButton
          key={provider}
          label={provider}
          count={count}
          active={scope.kind === "provider" && scope.provider === provider}
          onSelect={() => actions.selectScope({ kind: "provider", provider })}
        />
      ))}
    </nav>
  );
}

function AssignmentBar({
  assignment,
  onCancel,
}: {
  readonly assignment: HubAssignment;
  readonly onCancel: () => void;
}) {
  const text =
    assignment.kind === "role"
      ? `Choose a model for ${assignment.roleName}.`
      : `Choose a role for ${assignment.modelName}.`;
  return (
    <Toolbar ariaLabel="Assignment">
      <p className="min-w-0 flex-1 text-sm font-medium">{text}</p>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </Toolbar>
  );
}

/**
 * One model row. The row's button and its "Set as role" button are the only stops of the list for the
 * row that has focus; every other row is reached with the arrow keys, so Tab leaves the list.
 */
function ModelRowItem({
  row,
  active,
  choosing,
  setAsRoleBlocked,
  onUse,
  onSetAsRole,
  onActivate,
  onArrow,
}: {
  readonly row: HubModelRow;
  readonly active: boolean;
  /** A role is being chosen for a model: rows pick the role, and have no "Set as role". */
  readonly choosing: boolean;
  readonly setAsRoleBlocked: string | null;
  readonly onUse: () => void;
  readonly onSetAsRole: () => void;
  readonly onActivate: () => void;
  readonly onArrow: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { model } = row;
  const signIn = model.signIn === undefined ? null : signInLabel(model.signIn);
  return (
    <ListRow
      asOption={false}
      focusKey={rowFocusKey(row.key)}
      tabIndex={active ? 0 : -1}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate">{model.name}</span>
          {signIn ? (
            <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[0.7rem] font-normal text-muted-foreground">
              {signIn}
            </span>
          ) : null}
          {row.current ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.7rem] font-normal text-primary">
              Current
            </span>
          ) : null}
          {row.roles.map((role) => (
            <span
              key={role}
              className="shrink-0 rounded-full border border-primary/40 px-1.5 py-0.5 text-[0.7rem] font-normal text-primary"
            >
              {role}
            </span>
          ))}
        </span>
      }
      titleTooltip={model.name}
      detail={modelDetail(model, row.key)}
      selected={row.current}
      onSelect={onUse}
      onFocus={onActivate}
      onKeyDown={onArrow}
      trailing={
        choosing ? undefined : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Set ${model.name} as a role`}
            tabIndex={active ? 0 : -1}
            title={setAsRoleBlocked ?? undefined}
            disabled={setAsRoleBlocked !== null}
            onFocus={onActivate}
            onClick={onSetAsRole}
          >
            Set as role
          </Button>
        )
      }
    />
  );
}

function ModelsPane({ view, actions, requestFocus }: PaneProps) {
  const { catalog, scope, assignment } = view;
  const listRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowKeys = view.sections.flatMap((section) => section.rows.map((row) => row.key));
  const focusable =
    activeKey !== null && rowKeys.includes(activeKey) ? activeKey : (rowKeys[0] ?? null);
  const loading = catalog.loadState === "loading" || catalog.loadState === "idle";
  const { changes } = view.roles;
  const setAsRoleBlocked = changes.allowed ? null : (changes.reason ?? "Roles can't be changed.");
  const searching = view.query.trim() !== "";
  const choosingFor = assignment?.kind === "role" ? assignment : null;
  const firstRole = view.roles.rows[0]?.id;

  const moveFromRow = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const next = neighbourKey(event.key, rowKeys, key);
    if (next === null) return;
    event.preventDefault();
    setActiveKey(next);
    findFocusTarget(listRef.current, rowFocusKey(next))?.focus();
  };

  const renderRow = (row: HubModelRow) => (
    <ModelRowItem
      key={row.key}
      row={row}
      active={focusable === row.key}
      choosing={choosingFor !== null}
      setAsRoleBlocked={setAsRoleBlocked}
      onActivate={() => setActiveKey(row.key)}
      onArrow={(event) => moveFromRow(event, row.key)}
      onUse={() => {
        if (choosingFor) {
          requestFocus(roleChooseKey(choosingFor.roleId));
          actions.chooseModel(row.model);
        } else {
          requestFocus(rowFocusKey(row.key));
          actions.setSessionModel(row.model);
        }
      }}
      onSetAsRole={() => {
        if (firstRole) requestFocus(rolePickKey(firstRole));
        actions.startModelAssignment(row.key);
      }}
    />
  );

  return (
    <>
      {assignment ? (
        <AssignmentBar
          assignment={assignment}
          onCancel={() => {
            requestFocus(SEARCH);
            actions.cancelAssignment();
          }}
        />
      ) : null}
      <Input
        aria-label="Search models"
        data-focus-key={SEARCH}
        placeholder="Search models or providers"
        value={view.query}
        onChange={(event) => actions.setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || focusable === null) return;
          event.preventDefault();
          setActiveKey(focusable);
          findFocusTarget(listRef.current, rowFocusKey(focusable))?.focus();
        }}
        disabled={loading}
      />
      {view.recentError ? <InlineError variant="compact" message={view.recentError} /> : null}
      <div
        ref={listRef}
        data-testid="model-list"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border/70 p-2"
      >
        {loading ? (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            Loading models…
          </p>
        ) : catalog.error ? (
          <InlineError
            message={catalog.error}
            heading="The models could not be loaded."
            onRetry={actions.refreshModels}
            retryLabel="Try again"
          />
        ) : view.sections.length === 0 ? (
          <EmptyState
            variant="compact"
            title={modelsEmptyTitle(scope.kind === "provider" ? scope.provider : null, searching)}
            hint={
              searching || scope.kind === "provider"
                ? undefined
                : "Sign in to a provider in omp, then reopen this list."
            }
          />
        ) : (
          view.sections.map((section) =>
            section.heading === null ? (
              <div key={section.id} className="flex flex-col gap-1">
                {section.rows.map(renderRow)}
              </div>
            ) : (
              <Section
                key={section.id}
                heading={section.heading}
                variant="plain"
                ariaLabel={`${section.heading} models`}
              >
                <div className="flex flex-col gap-1">{section.rows.map(renderRow)}</div>
              </Section>
            ),
          )
        )}
      </div>
    </>
  );
}

function modelsEmptyTitle(provider: string | null, searching: boolean): string {
  if (searching) return "No models match this search.";
  if (provider !== null) return `No models for ${provider}.`;
  return "No models are available yet.";
}

/**
 * One role row. In the Roles view the row's "Choose model" button is its stop in the list, with "Clear"
 * after it; while a model is being assigned, the row itself picks the role.
 */
function RoleRowItem({
  row,
  view,
  actions,
  requestFocus,
  picking,
  active,
  onActivate,
  onArrow,
}: {
  readonly row: HubRoleRow;
  readonly view: ModelHubViewModel;
  readonly actions: ModelHubActions;
  readonly requestFocus: RequestFocus;
  readonly picking: boolean;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onArrow: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { changes } = view.roles;
  const blocked = changes.allowed ? null : (changes.reason ?? "Roles can't be changed.");
  const pickBlocked = row.unpickableReason ?? blocked;
  const detail =
    row.assigned === null
      ? (row.unpickableReason ?? "Not set. omp picks a model for this role.")
      : `${row.assigned.label}${row.assigned.thinkingLevel ? ` · ${row.assigned.thinkingLevel}` : ""}`;
  if (picking) {
    return (
      <ListRow
        asOption={false}
        focusKey={rolePickKey(row.id)}
        tabIndex={active ? 0 : -1}
        title={row.name}
        detail={detail}
        disabled={pickBlocked !== null}
        onFocus={onActivate}
        onKeyDown={onArrow}
        onSelect={() => {
          requestFocus(roleChooseKey(row.id));
          actions.chooseRole(row.id);
        }}
      />
    );
  }
  return (
    <ListRow
      title={row.name}
      detail={detail}
      trailing={
        <span className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Choose a model for ${row.name}`}
            aria-disabled={pickBlocked !== null || undefined}
            data-focus-key={roleChooseKey(row.id)}
            tabIndex={active ? 0 : -1}
            title={pickBlocked ?? undefined}
            onFocus={onActivate}
            onKeyDown={onArrow}
            onClick={() => {
              if (pickBlocked !== null) return;
              requestFocus(SEARCH);
              actions.startRoleAssignment(row.id);
            }}
          >
            Choose model
          </Button>
          {row.assigned ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Clear ${row.name}`}
              data-focus-key={`role-clear:${row.id}`}
              tabIndex={active ? 0 : -1}
              title={blocked ?? undefined}
              disabled={blocked !== null}
              onFocus={onActivate}
              onClick={() => {
                requestFocus(roleChooseKey(row.id));
                actions.clearRole(row.id);
              }}
            >
              Clear
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

function CycleOrder({ view, actions, requestFocus }: PaneProps) {
  const order = view.roles.cycleOrder;
  const blocked = view.roles.changes.allowed ? null : view.roles.changes.reason;
  return (
    <Section heading="Cycle order" variant="plain" ariaLabel="Cycle order">
      <p className="mb-1 text-xs text-muted-foreground">
        Ctrl+P moves through these roles in this order in omp.
      </p>
      {order.length === 0 ? (
        <p className="text-sm text-muted-foreground">No roles in the cycle.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {order.map((item, index) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-2 py-1 text-sm"
            >
              <span className="min-w-0 truncate">
                {index + 1}. {item.name}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.name} up`}
                  data-focus-key={cycleKey(-1, item.id)}
                  disabled={index === 0 || blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => {
                    requestFocus(cycleKey(-1, item.id));
                    actions.moveCycleRole(item.id, -1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.name} down`}
                  data-focus-key={cycleKey(1, item.id)}
                  disabled={index === order.length - 1 || blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => {
                    requestFocus(cycleKey(1, item.id));
                    actions.moveCycleRole(item.id, 1);
                  }}
                >
                  ↓
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function PresetsSection({ view, actions, requestFocus }: PaneProps) {
  const [name, setName] = useState("");
  const hintId = useId();
  const blocked = view.roles.changes.allowed ? null : view.roles.changes.reason;
  const trimmed = name.trim();
  return (
    <Section heading="Saved presets" variant="plain" ariaLabel="Saved presets">
      <p className="mb-1 text-xs text-muted-foreground">
        A preset keeps a set of roles and switches them together. Presets are saved for all
        projects.
      </p>
      <Toolbar ariaLabel="Save a preset">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">Preset name</span>
          <Input
            aria-label="Preset name"
            aria-describedby={hintId}
            data-focus-key={PRESET_NAME}
            placeholder="Name this set of roles"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <span id={hintId} className="text-xs text-muted-foreground">
            {view.presetNameRule}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={trimmed === "" || blocked !== null || view.busy}
          title={blocked ?? undefined}
          onClick={() => {
            requestFocus(PRESET_NAME);
            actions.savePreset(trimmed);
          }}
        >
          Save preset
        </Button>
      </Toolbar>
      <div className="mt-2 flex flex-col gap-1">
        {view.roles.presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved presets.</p>
        ) : null}
        {view.roles.presets.map((preset) => (
          <div
            key={preset}
            className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">{preset}</span>
            <span className="flex shrink-0 gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Switch to ${preset}`}
                data-focus-key={presetSwitchKey(preset)}
                title={blocked ?? undefined}
                disabled={blocked !== null || view.busy}
                onClick={() => {
                  requestFocus(presetSwitchKey(preset));
                  actions.switchPreset(preset);
                }}
              >
                Switch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete ${preset}`}
                title={blocked ?? undefined}
                disabled={blocked !== null || view.busy}
                onClick={() => {
                  requestFocus(PRESET_NAME);
                  actions.deletePreset(preset);
                }}
              >
                Delete
              </Button>
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RolesPane({ view, actions, requestFocus }: PaneProps) {
  const { roles } = view;
  const paneRef = useRef<HTMLDivElement>(null);
  const picking = view.assignment?.kind === "model";
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const chat = roles.rows.filter((row) => !row.kind);
  const other = roles.rows.filter((row) => row.kind);
  // Picking a role for a model only offers the roles that can take it.
  const stops = picking
    ? [...chat, ...other].filter((row) => row.unpickableReason === null)
    : [...chat, ...other];
  const stopIds = stops.map((row) => row.id);
  const focusable =
    activeRole !== null && stopIds.includes(activeRole) ? activeRole : (stopIds[0] ?? null);

  const moveFromRole = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const next = neighbourKey(event.key, stopIds, id);
    if (next === null) return;
    event.preventDefault();
    setActiveRole(next);
    const key = picking ? rolePickKey(next) : roleChooseKey(next);
    findFocusTarget(paneRef.current, key)?.focus();
  };

  const renderRole = (row: HubRoleRow) => (
    <RoleRowItem
      key={row.id}
      row={row}
      view={view}
      actions={actions}
      requestFocus={requestFocus}
      picking={picking}
      active={focusable === row.id}
      onActivate={() => setActiveRole(row.id)}
      onArrow={(event) => moveFromRole(event, row.id)}
    />
  );

  return (
    <div ref={paneRef} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pe-1">
      {view.assignment ? (
        <AssignmentBar
          assignment={view.assignment}
          onCancel={() => {
            requestFocus(SCOPE_ROLES);
            actions.cancelAssignment();
          }}
        />
      ) : null}
      {roles.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading roles…
        </p>
      ) : roles.status === "error" ? (
        <InlineError message={roles.error ?? "The roles could not be read."} />
      ) : (
        <>
          {roles.status === "conflict" ? (
            <p role="alert" className="text-sm text-muted-foreground">
              The saved roles changed elsewhere. They were reloaded; check them before choosing
              again.
            </p>
          ) : null}
          {!roles.changes.allowed ? (
            <p role="status" className="text-xs text-muted-foreground">
              {roles.changes.reason}
            </p>
          ) : null}
        </>
      )}
      <div className="flex flex-col gap-3">
        <Section heading="Chat roles" variant="plain" ariaLabel="Chat roles">
          <div className="flex flex-col gap-1">{chat.map(renderRole)}</div>
        </Section>
        <Section heading="Other roles" variant="plain" ariaLabel="Other roles">
          <div className="flex flex-col gap-1">{other.map(renderRole)}</div>
        </Section>
      </div>
      <CycleOrder view={view} actions={actions} requestFocus={requestFocus} />
      <PresetsSection view={view} actions={actions} requestFocus={requestFocus} />
    </div>
  );
}

/** The model dialog's body: the sidebar of lists, then the model list or the Roles view. */
export function ModelHub({
  view,
  actions,
}: {
  readonly view: ModelHubViewModel;
  readonly actions: ModelHubActions;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<string | null>(null);
  // An action can move the control it was started from (a row moves into Recent, a role row appears after a
  // pick). So a focus request waits until the action has finished, then goes to the control it asked for, if
  // that control is on screen. A request whose control is gone is dropped, and focus stays where it is.
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null || view.busy) return;
    pendingFocus.current = null;
    findFocusTarget(rootRef.current, key)?.focus();
  });
  const requestFocus: RequestFocus = (key) => {
    pendingFocus.current = key;
  };
  return (
    <section
      ref={rootRef}
      aria-label="Models"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Models</h2>
        {view.active ? (
          <p className="text-xs text-muted-foreground">Active: {view.active.key}</p>
        ) : null}
      </header>
      {view.notice?.tone === "error" ? (
        <InlineError
          variant="compact"
          message={view.notice.message}
          actions={
            <Button type="button" size="sm" variant="ghost" onClick={actions.dismissNotice}>
              Dismiss
            </Button>
          }
        />
      ) : view.notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {view.notice.message}
        </p>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 sm:flex-row">
        <Sidebar view={view} actions={actions} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {view.scope.kind === "roles" ? (
            <RolesPane view={view} actions={actions} requestFocus={requestFocus} />
          ) : (
            <ModelsPane view={view} actions={actions} requestFocus={requestFocus} />
          )}
        </div>
      </div>
    </section>
  );
}
