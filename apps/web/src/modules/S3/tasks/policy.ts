import type { AppClient } from "@omp-app/client";
import type { ConfigValue, FolderPath, Revision } from "@omp-app/contracts";
import { AppFailure, JsonValue } from "@omp-app/contracts";
import { createConfigStoreClient } from "../../S1/runtime";
import type { ConfigSnapshot, ConfigStoreClient } from "../../S1/settings-kit";
import { TASKS_SUBAGENTS_SECTION, TOOLS_TODOS_SECTION } from "../sections";

/** A task setting value and its ConfigStore provenance, refined to the consumer's value type. */
export interface TaskPolicyValue<Value> {
  readonly key: ConfigValue["key"];
  readonly secret: false;
  readonly value: Value;
  readonly source: ConfigValue["source"];
  readonly overrides: readonly ConfigValue["overrides"][number][];
  readonly provenance?: ConfigValue["provenance"];
}

export interface TodoPolicySnapshot {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly reminders: TaskPolicyValue<boolean>;
  readonly remindersMax: TaskPolicyValue<number>;
  readonly eager: TaskPolicyValue<"default" | "preferred" | "always">;
  readonly clearDelay: TaskPolicyValue<number>;
}

export type TaskServiceTier =
  | "inherit"
  | "none"
  | "auto"
  | "default"
  | "flex"
  | "scale"
  | "priority"
  | "ultrafast";

export interface SubagentPolicySnapshot {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly eager: TaskPolicyValue<"default" | "preferred" | "always">;
  readonly batch: TaskPolicyValue<boolean>;
  readonly speculativeLaunch: TaskPolicyValue<boolean>;
  readonly enableEffort: TaskPolicyValue<boolean>;
  readonly maxConcurrency: TaskPolicyValue<number>;
  readonly enableLsp: TaskPolicyValue<boolean>;
  readonly maxRecursionDepth: TaskPolicyValue<number>;
  readonly maxRuntimeMs: TaskPolicyValue<number>;
  readonly completionProbe: TaskPolicyValue<boolean>;
  readonly agentIdleTtlMs: TaskPolicyValue<number>;
  readonly softRequestBudget: TaskPolicyValue<number>;
  readonly softRequestBudgetNotice: TaskPolicyValue<boolean>;
  readonly maxEffort: TaskPolicyValue<"minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  readonly disabledAgents: TaskPolicyValue<readonly string[]>;
  readonly prewalk: TaskPolicyValue<boolean>;
  readonly showResolvedModelBadge: TaskPolicyValue<boolean>;
  /** All five ConfigStore maps retain their typed values and provenance in this immutable handoff. */
  readonly agentModelOverrides: TaskPolicyValue<
    Readonly<Record<string, string | readonly string[]>>
  >;
  readonly agentServiceTierOverrides: TaskPolicyValue<Readonly<Record<string, TaskServiceTier>>>;
  readonly agentCompactionThresholdOverrides: TaskPolicyValue<
    Readonly<Record<string, number | string | null>>
  >;
  readonly agentPrewalk: TaskPolicyValue<Readonly<Record<string, string>>>;
  readonly agentAdvisor: TaskPolicyValue<Readonly<Record<string, string>>>;
}

export interface TasksPolicySnapshot {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly todos: TodoPolicySnapshot;
  readonly subagents: SubagentPolicySnapshot;
}

const TASK_POLICY_KEYS: Record<string, true> = {};
for (const control of TOOLS_TODOS_SECTION.controls) TASK_POLICY_KEYS[control.key] = true;
for (const control of TASKS_SUBAGENTS_SECTION.controls) TASK_POLICY_KEYS[control.key] = true;

function invalidTaskSettings(): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message: "The task settings service returned an invalid value.",
    retryable: false,
  });
}

function settingEntry(snapshot: ConfigSnapshot, key: string): ConfigValue {
  let entry: ConfigValue | undefined;
  for (const candidate of snapshot.entries) {
    if (candidate.key === key) {
      if (candidate.secret) break;
      entry = candidate;
      break;
    }
  }
  if (!entry) {
    throw new AppFailure({
      code: "unavailable",
      message: "The task settings service did not return the complete policy.",
      retryable: true,
      capability: "host.config",
    });
  }
  return entry;
}

function policyValue<Value>(entry: ConfigValue, value: Value): TaskPolicyValue<Value> {
  return Object.freeze({
    key: entry.key,
    secret: false,
    value,
    source: entry.source,
    overrides: Object.freeze([...entry.overrides]),
    ...(entry.provenance === undefined
      ? {}
      : { provenance: Object.freeze({ ...entry.provenance }) }),
  });
}

function booleanSetting(snapshot: ConfigSnapshot, key: string): TaskPolicyValue<boolean> {
  const entry = settingEntry(snapshot, key);
  if (typeof entry.value !== "boolean") throw invalidTaskSettings();
  return policyValue(entry, entry.value);
}

function numberSetting(snapshot: ConfigSnapshot, key: string): TaskPolicyValue<number> {
  const entry = settingEntry(snapshot, key);
  if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) throw invalidTaskSettings();
  return policyValue(entry, entry.value);
}

function eagerSetting(
  snapshot: ConfigSnapshot,
  key: string,
): TaskPolicyValue<"default" | "preferred" | "always"> {
  const entry = settingEntry(snapshot, key);
  if (entry.value !== "default" && entry.value !== "preferred" && entry.value !== "always") {
    throw invalidTaskSettings();
  }
  return policyValue(entry, entry.value);
}

function maxEffortSetting(
  snapshot: ConfigSnapshot,
  key: string,
): TaskPolicyValue<"minimal" | "low" | "medium" | "high" | "xhigh" | "max"> {
  const entry = settingEntry(snapshot, key);
  if (
    entry.value !== "minimal" &&
    entry.value !== "low" &&
    entry.value !== "medium" &&
    entry.value !== "high" &&
    entry.value !== "xhigh" &&
    entry.value !== "max"
  ) {
    throw invalidTaskSettings();
  }
  return policyValue(entry, entry.value);
}

function stringListSetting(
  snapshot: ConfigSnapshot,
  key: string,
): TaskPolicyValue<readonly string[]> {
  const entry = settingEntry(snapshot, key);
  if (!Array.isArray(entry.value)) throw invalidTaskSettings();
  const values: string[] = [];
  for (const item of entry.value) {
    if (typeof item !== "string") throw invalidTaskSettings();
    values.push(item);
  }
  return policyValue(entry, Object.freeze(values));
}

function mappedSetting<Value>(
  snapshot: ConfigSnapshot,
  key: string,
  parse: (value: JsonValue) => Value,
): TaskPolicyValue<Readonly<Record<string, Value>>> {
  const entry = settingEntry(snapshot, key);
  const source = entry.value;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw invalidTaskSettings();
  }
  const entries: [string, Value][] = [];
  for (const [name, value] of Object.entries(source)) {
    entries.push([name, parse(JsonValue.parse(value))]);
  }
  const values: Record<string, Value> = Object.fromEntries(entries);
  return policyValue(entry, Object.freeze(values));
}

function parseModelOverride(value: JsonValue): string | readonly string[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw invalidTaskSettings();
  const models: string[] = [];
  for (const model of value) {
    if (typeof model !== "string") throw invalidTaskSettings();
    models.push(model);
  }
  return Object.freeze(models);
}

function parseServiceTier(value: JsonValue): TaskServiceTier {
  switch (value) {
    case "inherit":
    case "none":
    case "auto":
    case "default":
    case "flex":
    case "scale":
    case "priority":
    case "ultrafast":
      return value;
    default:
      throw invalidTaskSettings();
  }
}

function parseCompactionThreshold(value: JsonValue): number | string | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
    const percent = match ? Number(match[1]) : Number.NaN;
    if (percent > 0 && percent <= 100) return value;
  }
  throw invalidTaskSettings();
}

function parseAgentOverride(value: JsonValue): string {
  if (typeof value !== "string") throw invalidTaskSettings();
  return value;
}

/** Reads both consumer handoffs from one ConfigStore revision and keeps source/override metadata. */
export async function readTasksPolicySnapshot(
  client: ConfigStoreClient,
  folder: FolderPath | null,
): Promise<TasksPolicySnapshot> {
  const result = await client.list({ folder });
  const taskEntries: ConfigSnapshot["entries"][number][] = [];
  for (const entry of result.entries) {
    if (TASK_POLICY_KEYS[entry.key] === true) taskEntries.push(entry);
  }
  const snapshot: ConfigSnapshot = Object.freeze({
    folder,
    revision: result.revision,
    entries: Object.freeze(taskEntries),
  });
  const todos: TodoPolicySnapshot = Object.freeze({
    folder,
    revision: snapshot.revision,
    reminders: booleanSetting(snapshot, "todo.reminders"),
    remindersMax: numberSetting(snapshot, "todo.remindersMax"),
    eager: eagerSetting(snapshot, "todo.eager"),
    clearDelay: numberSetting(snapshot, "tasks.todoClearDelay"),
  });
  const subagents: SubagentPolicySnapshot = Object.freeze({
    folder,
    revision: snapshot.revision,
    eager: eagerSetting(snapshot, "task.eager"),
    batch: booleanSetting(snapshot, "task.batch"),
    speculativeLaunch: booleanSetting(snapshot, "task.speculativeLaunch"),
    enableEffort: booleanSetting(snapshot, "task.enableEffort"),
    maxConcurrency: numberSetting(snapshot, "task.maxConcurrency"),
    enableLsp: booleanSetting(snapshot, "task.enableLsp"),
    maxRecursionDepth: numberSetting(snapshot, "task.maxRecursionDepth"),
    maxRuntimeMs: numberSetting(snapshot, "task.maxRuntimeMs"),
    completionProbe: booleanSetting(snapshot, "task.completionProbe"),
    agentIdleTtlMs: numberSetting(snapshot, "task.agentIdleTtlMs"),
    softRequestBudget: numberSetting(snapshot, "task.softRequestBudget"),
    softRequestBudgetNotice: booleanSetting(snapshot, "task.softRequestBudgetNotice"),
    maxEffort: maxEffortSetting(snapshot, "task.maxEffort"),
    disabledAgents: stringListSetting(snapshot, "task.disabledAgents"),
    prewalk: booleanSetting(snapshot, "task.prewalk"),
    showResolvedModelBadge: booleanSetting(snapshot, "task.showResolvedModelBadge"),
    agentModelOverrides: mappedSetting(snapshot, "task.agentModelOverrides", parseModelOverride),
    agentServiceTierOverrides: mappedSetting(
      snapshot,
      "task.agentServiceTierOverrides",
      parseServiceTier,
    ),
    agentCompactionThresholdOverrides: mappedSetting(
      snapshot,
      "task.agentCompactionThresholdOverrides",
      parseCompactionThreshold,
    ),
    agentPrewalk: mappedSetting(snapshot, "task.agentPrewalk", parseAgentOverride),
    agentAdvisor: mappedSetting(snapshot, "task.agentAdvisor", parseAgentOverride),
  });
  return Object.freeze({ folder, revision: snapshot.revision, todos, subagents });
}

/** Uses the S1.2 adapter for the same A1 ConfigStore read path as the task section runtimes. */
export function readTasksPolicySnapshotFromApp(
  client: AppClient,
  folder: FolderPath | null,
): Promise<TasksPolicySnapshot> {
  return readTasksPolicySnapshot(createConfigStoreClient(client), folder);
}
