import type { CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import {
  type ModelCatalogLoadState,
  type ModelDescriptor,
  type ModelRoleSelector,
  modelScopeAvailability,
  ThinkingLevel,
} from "../contract";
import {
  descriptorKey,
  filterModels,
  type ModelCatalogModel,
  modelKey,
  modelRefFromDescriptor,
} from "../model/catalog";
import { RECENT_MODELS_LIMIT, type RecentModels } from "../model/recents";
import { type ModelRoleDefinition, roleDefinitions, splitRoleSelector } from "../model/role-list";
import { type ModelRoleStore, PRESET_NAME_RULE, type RoleStoreSnapshot } from "../model/roles";
import { groupByProvider, orderBySignIn } from "../model/sign-in-order";
import { disposeHubRoles } from "./open-roles";

/** Which list the dialog shows: the Roles view, every model (Recent first), or one provider's models. */
export type HubScope =
  | { readonly kind: "roles" }
  | { readonly kind: "all" }
  | { readonly kind: "provider"; readonly provider: string };

/** A model row. `roles` names the roles the model has, in role order. */
export interface HubModelRow {
  readonly key: string;
  readonly model: ModelDescriptor;
  readonly current: boolean;
  readonly roles: readonly string[];
}

/** A group of model rows under one heading; a heading of null is a plain list. */
export interface HubModelSection {
  readonly id: string;
  readonly heading: string | null;
  readonly rows: readonly HubModelRow[];
}

/** A role and the model it has now. `assigned` is null when the role is not set (omp then picks one). */
export interface HubRoleRow {
  readonly id: string;
  readonly name: string;
  readonly kind: boolean;
  readonly assigned: {
    readonly key: string;
    readonly label: string;
    /** Whether the model is one the app lists; a role can name a model that is not listed now. */
    readonly listed: boolean;
    readonly thinkingLevel: string | null;
  } | null;
  /** Why this role cannot take a model in the app, or null when it can. */
  readonly unpickableReason: string | null;
}

/** What the next model or role the person picks will do. Null when nothing is being assigned. */
export type HubAssignment =
  | { readonly kind: "role"; readonly roleId: string; readonly roleName: string }
  | { readonly kind: "model"; readonly key: string; readonly modelName: string };

export interface HubNotice {
  readonly tone: "status" | "error";
  readonly message: string;
}

export interface HubRolesView {
  /** `conflict`: the saved roles changed elsewhere and were reloaded; the person decides what to do next. */
  readonly status: "loading" | "ready" | "conflict" | "error";
  readonly error: string | null;
  /** Whether roles and presets can be changed now, and if not, the words that say why. */
  readonly changes: { readonly allowed: boolean; readonly reason: string | null };
  readonly rows: readonly HubRoleRow[];
  readonly assignedCount: number;
  readonly cycleOrder: readonly { readonly id: string; readonly name: string }[];
  readonly presets: readonly string[];
}

export interface ModelHubViewModel {
  readonly scope: HubScope;
  readonly query: string;
  readonly catalog: { readonly loadState: ModelCatalogLoadState; readonly error: string | null };
  /** The session's model: named in the dialog and marked in the list. */
  readonly active: { readonly key: string; readonly label: string } | null;
  /** Providers in the order the list shows them, with how many of their models can be picked. */
  readonly providers: readonly { readonly provider: string; readonly count: number }[];
  readonly modelCount: number;
  /** The model list for the scope after the search: empty for the Roles view. */
  readonly sections: readonly HubModelSection[];
  readonly matchCount: number;
  readonly recentError: string | null;
  readonly roles: HubRolesView;
  /** The rule a preset name must follow, in words the dialog shows beside the name. */
  readonly presetNameRule: string;
  readonly assignment: HubAssignment | null;
  readonly busy: boolean;
  readonly notice: HubNotice | null;
}

export interface ModelHubControllerOptions {
  readonly catalog: ModelCatalogModel;
  readonly recents: RecentModels;
  /** Read at each change, so the dialog sees a capability that arrives after it opened. */
  readonly capabilities: () => CapabilityMap;
  /** Called after omp has taken a new session model or thinking level, so the header reads omp's state again. */
  readonly onSessionChanged?: () => void;
  /** Sets the session's thinking level. Left out, a thinking level in a role or preset is not set on the session. */
  readonly setSessionThinking?: (level: ThinkingLevel) => Promise<void>;
}

/**
 * The roles the dialog works with. `saved` is the global layer, where presets and the cycle order live.
 * `shown` is the layer whose roles the dialog lists: the same store as `saved`, unless the project keeps
 * its own roles.
 */
export interface HubRoles {
  readonly saved: ModelRoleStore;
  readonly shown: ModelRoleStore;
}

type Assignment = { readonly kind: "role" | "model"; readonly id: string };

interface SectionDraft {
  readonly id: string;
  readonly heading: string | null;
  readonly models: readonly ModelDescriptor[];
}

interface RoleState {
  readonly rows: readonly HubRoleRow[];
  /** Model key → the names of the roles it has. */
  readonly owners: ReadonlyMap<string, readonly string[]>;
  /** The model key each role names, in role order (listed or not). */
  readonly assignedKeys: readonly string[];
}

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function withNote(message: string, note: string | null): string {
  return note === null ? message : `${message} ${note}`;
}

/** The thinking levels omp offers a model: none for a model without reasoning (model-hub.ts:1242-1245 at v18.6.1). */
function thinkingLevelsFor(model: ModelDescriptor): readonly string[] {
  if (!model.reasoning) return [];
  return ["off", "auto", ...model.thinkingEfforts];
}

/**
 * The level a role keeps when its model is replaced: only a level the new model offers, as omp does
 * (model-hub.ts:1199-1207 at v18.6.1). Null means the role takes the model's default.
 */
function keptLevel(current: ModelRoleSelector | undefined, model: ModelDescriptor): string | null {
  if (current === undefined) return null;
  const text = typeof current === "string" ? current : modelKey(current);
  const level = splitRoleSelector(text).thinkingLevel;
  if (level === null || level === "inherit") return null;
  return thinkingLevelsFor(model).includes(level) ? level : null;
}

function buildRoleState(
  selectors: Readonly<Record<string, ModelRoleSelector>>,
  cycleOrder: readonly string[],
  listed: ReadonlyMap<string, ModelDescriptor>,
): RoleState {
  const owners = new Map<string, string[]>();
  const assignedKeys: string[] = [];
  const rows = roleDefinitions([...Object.keys(selectors), ...cycleOrder]).map(
    (definition): HubRoleRow => {
      const base = {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        unpickableReason: definition.unpickableReason,
      };
      const selector = Object.hasOwn(selectors, definition.id)
        ? selectors[definition.id]
        : undefined;
      if (selector === undefined) return { ...base, assigned: null };
      const text = typeof selector === "string" ? selector : modelKey(selector);
      const parsed = splitRoleSelector(text);
      const key = parsed.model ? modelKey(parsed.model) : text;
      const model = listed.get(key);
      if (model) owners.set(key, [...(owners.get(key) ?? []), definition.name]);
      assignedKeys.push(key);
      return {
        ...base,
        assigned: {
          key,
          label: model ? `${model.name} · ${key}` : key,
          listed: model !== undefined,
          thinkingLevel: parsed.thinkingLevel,
        },
      };
    },
  );
  return { rows, owners, assignedKeys };
}

/** Recent: the models the roles use, the current model, then the models used lately (most recent first). */
function recentModelsOf(
  listed: ReadonlyMap<string, ModelDescriptor>,
  assignedKeys: readonly string[],
  currentKey: string | null,
  recentKeys: readonly string[],
): ModelDescriptor[] {
  const candidates = [
    ...assignedKeys,
    ...(currentKey ? [currentKey] : []),
    ...recentKeys.slice(0, RECENT_MODELS_LIMIT),
  ];
  const seen = new Set<string>();
  const models: ModelDescriptor[] = [];
  for (const key of candidates) {
    const model = listed.get(key);
    if (!model || seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

function modelRow(
  model: ModelDescriptor,
  currentKey: string | null,
  owners: ReadonlyMap<string, readonly string[]>,
): HubModelRow {
  const key = descriptorKey(model);
  return { key, model, current: key === currentKey, roles: owners.get(key) ?? [] };
}

/**
 * The state of the model dialog and the actions the model list and the Roles view call. The catalog,
 * recents and roles are owned here and disposed with it. Views read `getSnapshot()` and call the actions;
 * a view never calls RPC or ConfigStore itself.
 */
export class ModelHubController {
  private readonly catalog: ModelCatalogModel;
  private readonly recents: RecentModels;
  private readonly capabilities: () => CapabilityMap;
  private readonly onSessionChanged: (() => void) | undefined;
  private readonly setThinking: ((level: ThinkingLevel) => Promise<void>) | undefined;
  private readonly listeners = new Set<(view: ModelHubViewModel) => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private roles: HubRoles | null = null;
  private rolesError: string | null = null;
  private scope: HubScope = { kind: "all" };
  private query = "";
  private assignment: Assignment | null = null;
  private notice: HubNotice | null = null;
  private busyCount = 0;
  private disposed = false;
  private view: ModelHubViewModel;

  public constructor(options: ModelHubControllerOptions) {
    this.catalog = options.catalog;
    this.recents = options.recents;
    this.capabilities = options.capabilities;
    this.onSessionChanged = options.onSessionChanged;
    this.setThinking = options.setSessionThinking;
    this.unsubscribers.push(
      this.catalog.subscribe(() => this.publish()),
      this.recents.subscribe(() => this.publish()),
    );
    this.view = this.derive();
  }

  public getSnapshot(): ModelHubViewModel {
    return this.view;
  }

  public subscribe(listener: (view: ModelHubViewModel) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Hands the dialog its roles once they are read. Roles that arrive after the dialog closed are disposed. */
  public attachRoles(roles: HubRoles): void {
    if (this.disposed) {
      disposeHubRoles(roles);
      return;
    }
    this.roles = roles;
    this.rolesError = null;
    const stores = roles.shown === roles.saved ? [roles.saved] : [roles.saved, roles.shown];
    for (const store of stores) this.unsubscribers.push(store.subscribe(() => this.publish()));
    this.publish();
  }

  public failRoles(message: string): void {
    this.rolesError = message;
    this.publish();
  }

  public setScope(scope: HubScope): void {
    this.scope = scope;
    this.publish();
  }

  public setQuery(query: string): void {
    this.query = query;
    this.publish();
  }

  public dismissNotice(): void {
    this.notice = null;
    this.publish();
  }

  /** The Roles view's "Choose model": the model list now picks a model for the role. */
  public startRoleAssignment(roleId: string): void {
    this.assignment = { kind: "role", id: roleId };
    this.scope = { kind: "all" };
    this.notice = null;
    this.publish();
  }

  /** A model's "Set as role": the Roles view now picks the role for the model. */
  public startModelAssignment(key: string): void {
    this.assignment = { kind: "model", id: key };
    this.scope = { kind: "roles" };
    this.notice = null;
    this.publish();
  }

  public cancelAssignment(): void {
    this.assignment = null;
    this.publish();
  }

  /** A model row: the session uses it. */
  public async setSessionModel(model: ModelDescriptor): Promise<void> {
    await this.run("Changing the model failed.", async () => {
      await this.switchSession(model);
      return `Now using ${model.name}.`;
    });
  }

  /** A model picked for the role being chosen. On success the dialog returns to the Roles view. */
  public async chooseModel(model: ModelDescriptor): Promise<void> {
    const assignment = this.assignment;
    if (assignment?.kind !== "role") return;
    await this.run("Saving the role failed.", async () => {
      this.requirePickable(assignment.id);
      const note = await this.assignTo(assignment.id, model);
      this.assignment = null;
      this.scope = { kind: "roles" };
      return withNote(`${this.roleName(assignment.id)} now uses ${model.name}.`, note);
    });
  }

  /** A role picked for the model being assigned. */
  public async chooseRole(roleId: string): Promise<void> {
    const assignment = this.assignment;
    if (assignment?.kind !== "model") return;
    const model = this.catalog
      .getSnapshot()
      .models.find((candidate) => descriptorKey(candidate) === assignment.id);
    if (!model) {
      this.assignment = null;
      this.notice = { tone: "error", message: "That model is no longer listed." };
      this.publish();
      return;
    }
    await this.run("Saving the role failed.", async () => {
      this.requirePickable(roleId);
      const note = await this.assignTo(roleId, model);
      this.assignment = null;
      return withNote(`${this.roleName(roleId)} now uses ${model.name}.`, note);
    });
  }

  public async clearRole(roleId: string): Promise<void> {
    await this.run("Clearing the role failed.", async () => {
      await this.requireChanges().saved.unassignRole(roleId);
      return `${this.roleName(roleId)} is cleared. omp picks a model for it.`;
    });
  }

  public async moveCycleRole(roleId: string, direction: -1 | 1): Promise<void> {
    await this.run("Changing the cycle order failed.", async () => {
      await this.requireChanges().saved.moveCycleRole(roleId, direction);
      return undefined;
    });
  }

  /** Saves the roles as a preset. A name omp would refuse is refused before anything is written. */
  public async savePreset(name: string): Promise<void> {
    await this.run("Saving the preset failed.", async () => {
      await this.requireChanges().saved.savePreset(name);
      return `Saved preset ${name.trim()}.`;
    });
  }

  /**
   * Applies a preset as omp does (model-presets.ts:321-390 at v18.6.1): the default model is checked first,
   * and a preset whose default is missing, not listed or a role or pattern is refused before anything is
   * written. Then the roles are saved, the session takes the default model, and the thinking level is set.
   */
  public async switchPreset(name: string): Promise<void> {
    await this.run("Switching the preset failed.", async () => {
      const roles = this.requireChanges();
      const preset = roles.saved.getSnapshot().settings.modelPresets[name];
      if (!preset) throw new Error(`Preset ${name} is no longer saved.`);
      const selector = preset.modelRoles.default;
      if (selector === undefined) {
        throw new Error(`Preset ${name} was not applied: it has no default model.`);
      }
      if (selector.startsWith("@") || selector.includes("*")) {
        throw new Error(
          `Preset ${name} was not applied: its default model ${selector} is a role or a pattern, not one model.`,
        );
      }
      const parsed = splitRoleSelector(selector);
      const model = parsed.model ? this.availableModel(modelKey(parsed.model)) : undefined;
      if (!model) {
        throw new Error(
          `Preset ${name} was not applied: its default model ${selector} is not available.`,
        );
      }
      await roles.saved.switchPreset(name);
      try {
        await this.switchSession(model);
      } catch (error) {
        throw new Error(
          `Preset ${name} is saved, but the session model could not be changed: ${failureMessage(error, "unknown error")}`,
        );
      }
      const level = parsed.thinkingLevel ?? preset.defaultThinkingLevel ?? null;
      const note = level === null ? null : await this.applySessionThinking(level);
      return withNote(`Switched to preset ${name}.`, note);
    });
  }

  public async deletePreset(name: string): Promise<void> {
    await this.run("Deleting the preset failed.", async () => {
      await this.requireChanges().saved.deletePreset(name);
      return `Deleted preset ${name}.`;
    });
  }

  public async refreshModels(): Promise<void> {
    await this.run("Refreshing the models failed.", async () => {
      await this.catalog.refresh();
      return undefined;
    });
  }

  public dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.listeners.clear();
    this.catalog.dispose();
    this.recents.dispose();
    if (this.roles) disposeHubRoles(this.roles);
  }

  private async switchSession(model: ModelDescriptor): Promise<void> {
    const ref = modelRefFromDescriptor(model);
    await this.catalog.apply({ model: ref, scope: "session" });
    this.onSessionChanged?.();
    await this.recents.record(ref);
  }

  /**
   * Sets a role to the model, keeping the role's thinking level when the model offers it. The role is saved
   * first: when that fails nothing else changes. The default role then switches the session, as omp's hub does.
   */
  private async assignTo(roleId: string, model: ModelDescriptor): Promise<string | null> {
    const roles = this.requireChanges();
    const level = keptLevel(roles.saved.getSnapshot().settings.modelRoles[roleId], model);
    const key = modelKey(modelRefFromDescriptor(model));
    await roles.saved.assignRole(roleId, level === null ? key : `${key}:${level}`);
    if (roleId !== "default") return null;
    try {
      await this.switchSession(model);
    } catch (error) {
      throw new Error(
        `The role is saved, but the session model could not be changed: ${failureMessage(error, "unknown error")}`,
      );
    }
    return level === null ? null : this.applySessionThinking(level);
  }

  /** Sets the session's thinking level. Returns a plain note when it could not be set, or null when it was. */
  private async applySessionThinking(level: string): Promise<string | null> {
    if (level === "inherit") return null;
    const parsed = ThinkingLevel.safeParse(level);
    if (!parsed.success) {
      return "The app can't set omp's automatic thinking level yet, so the session keeps its level.";
    }
    if (!this.setThinking) return "The session's thinking level can't be set from here.";
    try {
      await this.setThinking(parsed.data);
      this.onSessionChanged?.();
      return null;
    } catch (error) {
      return failureMessage(error, "The session's thinking level could not be set.");
    }
  }

  private async run(fallback: string, operation: () => Promise<string | undefined>): Promise<void> {
    this.busyCount += 1;
    this.notice = null;
    this.publish();
    try {
      const message = await operation();
      if (message) this.notice = { tone: "status", message };
    } catch (error) {
      this.notice = { tone: "error", message: failureMessage(error, fallback) };
    } finally {
      this.busyCount -= 1;
      this.publish();
    }
  }

  /** The role stores, when the dialog may change them now; otherwise it throws the words that say why not. */
  private requireChanges(): HubRoles {
    const changes = this.changesState(this.roles);
    if (!changes.allowed || this.roles === null) {
      throw new Error(changes.reason ?? "Roles can't be changed right now.");
    }
    return this.roles;
  }

  private requirePickable(roleId: string): void {
    const reason = this.definitionOf(roleId)?.unpickableReason ?? null;
    if (reason !== null) throw new Error(reason);
  }

  private definitions(): readonly ModelRoleDefinition[] {
    const configured = Object.keys(this.roles?.shown.getSnapshot().settings.modelRoles ?? {});
    const cycle = this.roles?.saved.getSnapshot().settings.cycleOrder ?? [];
    return roleDefinitions([...configured, ...cycle]);
  }

  private definitionOf(roleId: string): ModelRoleDefinition | undefined {
    return this.definitions().find((definition) => definition.id === roleId);
  }

  private roleName(roleId: string): string {
    return this.definitionOf(roleId)?.name ?? roleId;
  }

  /** A model the session can switch to right now: listed, and signed in (available). */
  private availableModel(key: string): ModelDescriptor | undefined {
    return this.catalog
      .getSnapshot()
      .models.find((model) => model.availability === "available" && descriptorKey(model) === key);
  }

  /** Whether role changes are allowed, computed from the roles as they are now. */
  private changesState(roles: HubRoles | null): { allowed: boolean; reason: string | null } {
    if (this.rolesError !== null) return { allowed: false, reason: this.rolesError };
    if (roles === null) return { allowed: false, reason: "The roles are still loading." };
    const shown = roles.shown.getSnapshot();
    if (shown.status === "error") {
      return { allowed: false, reason: shown.error?.message ?? "The roles could not be read." };
    }
    if (roles.shown !== roles.saved) {
      return {
        allowed: false,
        reason:
          "Roles are saved for this project. This app can show them but can't change them yet.",
      };
    }
    const availability = modelScopeAvailability("default", this.capabilities());
    if (availability.state === "unavailable") {
      return { allowed: false, reason: availability.reason };
    }
    return { allowed: true, reason: null };
  }

  private publish(): void {
    if (this.disposed) return;
    this.view = this.derive();
    for (const listener of this.listeners) listener(this.view);
  }

  private derive(): ModelHubViewModel {
    const catalog = this.catalog.getSnapshot();
    const recents = this.recents.getSnapshot();
    const available = catalog.models.filter((model) => model.availability === "available");
    const listed = new Map(available.map((model) => [descriptorKey(model), model] as const));
    const currentKey = catalog.current ? modelKey(catalog.current) : null;
    const shown = this.roles?.shown.getSnapshot() ?? null;
    const saved = this.roles?.saved.getSnapshot() ?? null;
    const roleState = buildRoleState(
      shown?.settings.modelRoles ?? {},
      saved?.settings.cycleOrder ?? [],
      listed,
    );
    const sections = this.sectionsFor(available, listed, roleState, currentKey, recents.keys).map(
      (draft): HubModelSection => ({
        id: draft.id,
        heading: draft.heading,
        rows: draft.models.map((model) => modelRow(model, currentKey, roleState.owners)),
      }),
    );
    return {
      scope: this.scope,
      query: this.query,
      catalog: {
        loadState: catalog.loadState,
        error: catalog.loadState === "error" ? (catalog.error?.message ?? null) : null,
      },
      active: currentKey
        ? { key: currentKey, label: listed.get(currentKey)?.name ?? currentKey }
        : null,
      providers: groupByProvider(orderBySignIn(available)).map((group) => ({
        provider: group.provider,
        count: group.models.length,
      })),
      modelCount: available.length,
      sections,
      matchCount: sections.reduce((total, section) => total + section.rows.length, 0),
      recentError: recents.error,
      roles: this.rolesView(roleState, shown, saved),
      presetNameRule: PRESET_NAME_RULE,
      assignment: this.assignmentView(listed),
      busy: this.busyCount > 0,
      notice: this.notice,
    };
  }

  /** The model list for the scope: Recent first on All models, then provider groups, after the search. */
  private sectionsFor(
    available: readonly ModelDescriptor[],
    listed: ReadonlyMap<string, ModelDescriptor>,
    roleState: RoleState,
    currentKey: string | null,
    recentKeys: readonly string[],
  ): SectionDraft[] {
    if (this.scope.kind === "roles") return [];
    const matches = (models: readonly ModelDescriptor[]) => filterModels(models, this.query);
    if (this.scope.kind === "provider") {
      const provider = this.scope.provider;
      const models = matches(available.filter((model) => model.provider === provider));
      return [{ id: `provider:${provider}`, heading: null, models }];
    }
    const recent = recentModelsOf(listed, roleState.assignedKeys, currentKey, recentKeys);
    const recentIds = new Set(recent.map((model) => descriptorKey(model)));
    const sections: SectionDraft[] = [];
    const recentMatches = matches(recent);
    if (recentMatches.length > 0) {
      sections.push({ id: "recent", heading: "Recent", models: recentMatches });
    }
    const rest = matches(available.filter((model) => !recentIds.has(descriptorKey(model))));
    for (const group of groupByProvider(orderBySignIn(rest))) {
      sections.push({
        id: `provider:${group.provider}`,
        heading: group.provider,
        models: group.models,
      });
    }
    return sections;
  }

  private rolesView(
    roleState: RoleState,
    shown: RoleStoreSnapshot | null,
    saved: RoleStoreSnapshot | null,
  ): HubRolesView {
    const definitions = this.definitions();
    return {
      status: this.rolesStatus(shown),
      error: this.rolesError ?? shown?.error?.message ?? null,
      changes: this.changesState(this.roles),
      rows: roleState.rows,
      assignedCount: roleState.rows.filter((row) => row.assigned !== null).length,
      cycleOrder: (saved?.settings.cycleOrder ?? []).map((id) => ({
        id,
        name: definitions.find((definition) => definition.id === id)?.name ?? id,
      })),
      presets: Object.keys(saved?.settings.modelPresets ?? {}),
    };
  }

  private rolesStatus(shown: RoleStoreSnapshot | null): HubRolesView["status"] {
    if (this.rolesError !== null) return "error";
    if (this.roles === null) return "loading";
    if (shown === null || shown.status === "idle" || shown.status === "loading") return "loading";
    if (shown.status === "conflict") return "conflict";
    return shown.status === "error" ? "error" : "ready";
  }

  private assignmentView(listed: ReadonlyMap<string, ModelDescriptor>): HubAssignment | null {
    const assignment = this.assignment;
    if (assignment === null) return null;
    if (assignment.kind === "role") {
      return { kind: "role", roleId: assignment.id, roleName: this.roleName(assignment.id) };
    }
    return {
      kind: "model",
      key: assignment.id,
      modelName: listed.get(assignment.id)?.name ?? assignment.id,
    };
  }
}
