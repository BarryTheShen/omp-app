import { AppFailure } from "@omp-app/contracts";
import {
  type ModelDescriptor,
  type ModelRef,
  type ModelRoleSelector,
  ThinkingLevel,
} from "../contract";
import {
  descriptorKey,
  type ModelCatalogModel,
  modelKey,
  modelRefFromDescriptor,
  roleSelectorKey,
} from "./catalog";
import { splitRoleSelector } from "./role-list";

/** The roles a cycle steps through, as the settings hold them: each role's selector and the order to step in. */
export interface RoleCycleSettings {
  readonly modelRoles: Readonly<Record<string, ModelRoleSelector>>;
  readonly cycleOrder: readonly string[];
}

/** A role that resolves to a model the session can use now. */
export interface RoleCycleEntry {
  readonly role: string;
  readonly model: ModelDescriptor;
  /** The `:level` the selector names; null when it names none, names `auto`, or names `inherit`. */
  readonly thinkingLevel: ThinkingLevel | null;
}

export interface RoleCycle {
  readonly entries: readonly RoleCycleEntry[];
  /**
   * The entry the session's model is at: the role last applied while its model is still the session's, else the first
   * role that names the session's model, else the first entry.
   */
  readonly currentIndex: number;
}

export type RoleCycleDirection = "forward" | "backward";

export interface RoleCycleDeps {
  readonly catalog: ModelCatalogModel;
  /** The saved roles and cycle order, read as the Model Hub reads them. */
  readonly readSettings: () => Promise<RoleCycleSettings>;
  /** Reads omp's session state again; resolves once the store holds it. */
  readonly readSession: () => Promise<void>;
  /** Sets the session's thinking level. */
  readonly setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  /** The role the last step applied in this chat, or null. Two roles may name one model; this tells them apart. */
  readonly lastRole: string | null;
}

export type RoleCycleOutcome =
  | { readonly kind: "single" }
  | {
      readonly kind: "changed";
      /** The role the step applied. */
      readonly role: string;
      /** Why the role's thinking level could not be set. The model has changed either way; null when it was set. */
      readonly thinkingError: string | null;
    };

/**
 * The selector a role names as `provider/id[:level]`. The `default` role stands for the session's model when
 * no selector is set (getRoleModelCycle, model-controls.ts:348-350 at omp v18.12.5).
 */
function selectorOf(
  role: string,
  settings: RoleCycleSettings,
  current: ModelRef | null,
): string | null {
  const configured = settings.modelRoles[role];
  if (configured !== undefined) return roleSelectorKey(configured);
  return role === "default" && current !== null ? modelKey(current) : null;
}

/**
 * A selector's `:level` as a thinking level. omp's `auto` names none (concreteThinkingLevel, pi-tui
 * thinking.ts:155). `inherit` names none here: the app leaves the session's level alone, as the Model Hub does. The
 * RPC's level list leaves `inherit` out (rpc-mode.ts:2315-2317), where omp would pass it on.
 */
function namedLevel(suffix: string | null): ThinkingLevel | null {
  if (suffix === null) return null;
  const parsed = ThinkingLevel.safeParse(suffix);
  return parsed.success && parsed.data !== "inherit" ? parsed.data : null;
}

/**
 * The roles in cycle order that resolve to a model the session can use now, and where the session's model is
 * among them. A role with no selector, or with a model that is not available, is skipped, as omp skips it
 * (getRoleModelCycle, model-controls.ts:337 at omp v18.12.5). A selector resolves only as an exact
 * `provider/id`; omp also resolves partial ids, glob patterns and `@role` aliases, which the app does not yet.
 * The position is the last applied role while its model is still the session's model, as omp trusts its recorded
 * role (model-controls.ts:368-378 at v18.12.5): two roles that name one model would otherwise step to each other.
 */
export function resolveRoleCycle(
  settings: RoleCycleSettings,
  models: readonly ModelDescriptor[],
  current: ModelRef | null,
  lastRole: string | null = null,
): RoleCycle {
  const available = new Map(
    models
      .filter((model) => model.availability === "available")
      .map((model) => [descriptorKey(model), model] as const),
  );
  const entries: RoleCycleEntry[] = [];
  for (const role of settings.cycleOrder) {
    const selector = selectorOf(role, settings, current);
    if (selector === null) continue;
    const parsed = splitRoleSelector(selector);
    const model = parsed.model === null ? undefined : available.get(modelKey(parsed.model));
    if (model === undefined) continue;
    entries.push({ role, model, thinkingLevel: namedLevel(parsed.thinkingLevel) });
  }
  if (current === null) return { entries, currentIndex: 0 };
  const currentKey = modelKey(current);
  const recorded = entries.findIndex(
    (entry) => entry.role === lastRole && descriptorKey(entry.model) === currentKey,
  );
  const at =
    recorded !== -1
      ? recorded
      : entries.findIndex((entry) => descriptorKey(entry.model) === currentKey);
  return { entries, currentIndex: Math.max(at, 0) };
}

/** The entry one step from the current one, wrapping at either end; null when fewer than two roles resolve. */
export function nextRoleEntry(
  cycle: RoleCycle,
  direction: RoleCycleDirection,
): RoleCycleEntry | null {
  const count = cycle.entries.length;
  if (count < 2) return null;
  const step = direction === "forward" ? 1 : -1;
  return cycle.entries[(cycle.currentIndex + step + count) % count] ?? null;
}

function failureMessage(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error ? error.message : "The thinking level could not be set.";
}

/**
 * Steps the session to the next role's model, as omp's cycleRoleModels does (model-controls.ts:404-416 at omp
 * v18.12.5): the model is set first, then the role's thinking level when the role names one. The chat's state is
 * read again once the model has changed, so the thinking levels checked are the new model's. A failed model
 * change throws and nothing else runs. A thinking level the model refuses leaves the new model in place and is
 * returned as text.
 */
export async function cycleRoleModel(
  deps: RoleCycleDeps,
  direction: RoleCycleDirection,
): Promise<RoleCycleOutcome> {
  const { models, current } = await deps.catalog.refresh();
  const settings = await deps.readSettings();
  const next = nextRoleEntry(resolveRoleCycle(settings, models, current, deps.lastRole), direction);
  if (next === null) return { kind: "single" };
  await deps.catalog.apply({ model: modelRefFromDescriptor(next.model), scope: "session" });
  await deps.readSession();
  if (next.thinkingLevel === null) return { kind: "changed", role: next.role, thinkingError: null };
  try {
    await deps.setThinkingLevel(next.thinkingLevel);
    await deps.readSession();
    return { kind: "changed", role: next.role, thinkingError: null };
  } catch (error) {
    return {
      kind: "changed",
      role: next.role,
      thinkingError: `The model changed, but its thinking level could not be set: ${failureMessage(error)}`,
    };
  }
}
