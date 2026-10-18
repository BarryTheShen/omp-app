import type { AppClient } from "@omp-app/client";
import type { ConfigEntry, ConfigWriteLayer, FolderPath } from "@omp-app/contracts";
import {
  type ConflictChoice,
  createSettingsRuntime,
  type SettingsRuntime,
  type SettingsRuntimeListener,
  type SettingsRuntimeSnapshot,
} from "../../S1/runtime";
import type {
  CommitResult,
  ConfigSnapshot,
  PreviewResult,
  SettingControl,
  SettingValue,
  StageResult,
} from "../../S1/settings-kit";
import {
  TASKS_COMMANDS_SKILLS_SECTION,
  TASKS_ISOLATION_SECTION,
  TASKS_MODES_SECTION,
  TASKS_SUBAGENTS_SECTION,
  TOOLS_TODOS_SECTION,
} from "../sections";

export const TASK_SETTINGS_SECTIONS = Object.freeze({
  todos: TOOLS_TODOS_SECTION,
  commandsSkills: TASKS_COMMANDS_SKILLS_SECTION,
  isolation: TASKS_ISOLATION_SECTION,
  modes: TASKS_MODES_SECTION,
  subagents: TASKS_SUBAGENTS_SECTION,
});

export type TaskSettingsSectionId = keyof typeof TASK_SETTINGS_SECTIONS;
export type IsolationSettingKey =
  | "task.isolation.enabled"
  | "isolation.backend"
  | "worktree.clone"
  | "worktree.cleanSource"
  | "task.isolation.apply"
  | "task.isolation.merge"
  | "task.isolation.commits"
  | "worktree.base";

export interface IsolationSaveConfirmation {
  readonly title: string;
  readonly message: string;
  readonly changes: readonly string[];
}

export interface TaskSettingsSaveOptions {
  readonly confirmIsolation?: (confirmation: IsolationSaveConfirmation) => Promise<boolean>;
}

export type TaskSettingsSaveResult =
  | { readonly status: "saved"; readonly result: CommitResult }
  | { readonly status: "confirmation-required"; readonly confirmation: IsolationSaveConfirmation }
  | { readonly status: "cancelled"; readonly changes: readonly string[] }
  | { readonly status: "stale-confirmation"; readonly changes: readonly string[] };

const ISOLATION_SETTING_KEYS: readonly IsolationSettingKey[] = [
  "task.isolation.enabled",
  "isolation.backend",
  "worktree.clone",
  "worktree.cleanSource",
  "task.isolation.apply",
  "task.isolation.merge",
  "task.isolation.commits",
  "worktree.base",
];

const DESTRUCTIVE_ISOLATION_KEYS: readonly IsolationSettingKey[] = [
  "worktree.cleanSource",
  "task.isolation.apply",
];
function isTrueSetting(setting: SettingValue | ConfigEntry | undefined): boolean {
  return setting?.secret === false && setting.value === true;
}

function valueText(control: SettingControl, setting: SettingValue | undefined): string {
  if (setting === undefined || setting.secret) return "";
  const value = setting.value;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") {
    const options = "options" in control ? control.options : undefined;
    return options?.find((option) => option.value === value)?.label ?? value;
  }
  return JSON.stringify(value);
}

function isolationChanges(
  snapshot: SettingsRuntimeSnapshot,
  keys: readonly IsolationSettingKey[],
): readonly string[] {
  const changes: string[] = [];
  for (const key of keys) {
    const control = snapshot.descriptor.controls.find((candidate) => candidate.key === key);
    if (!control) throw new Error("A task isolation change needs a confirmation label.");
    changes.push(`${control.label}: ${valueText(control, snapshot.staged?.edits[key])}`);
  }
  return Object.freeze(changes);
}

export interface TasksSettingsRuntimeOptions {
  readonly section: TaskSettingsSectionId;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
}

/** Wraps S1.2's existing ConfigStore runtime for task settings. */
export class TaskSettingsSectionRuntime {
  private readonly runtime: SettingsRuntime;

  public constructor(runtime: SettingsRuntime) {
    this.runtime = runtime;
  }

  public getSnapshot(): SettingsRuntimeSnapshot {
    return this.runtime.getSnapshot();
  }

  public subscribe(listener: SettingsRuntimeListener): () => void {
    return this.runtime.subscribe(listener);
  }

  public read(): Promise<ConfigSnapshot> {
    return this.runtime.read();
  }

  public stage(key: string, value: SettingValue): StageResult {
    return this.runtime.stage(key, value);
  }

  public preview(key: string): PreviewResult {
    return this.runtime.preview(key);
  }

  public cancel(): void {
    this.runtime.cancel();
  }

  public resolveConflict(choice: ConflictChoice): void {
    this.runtime.resolveConflict(choice);
  }

  public retry(): Promise<ConfigSnapshot> {
    return this.runtime.retry();
  }

  public dispose(): void {
    this.runtime.dispose();
  }

  public async save(options?: TaskSettingsSaveOptions): Promise<TaskSettingsSaveResult> {
    const initial = this.runtime.getSnapshot();
    const staged = initial.staged;
    const isolationKeys: IsolationSettingKey[] = [];
    if (initial.descriptor.id === TASKS_ISOLATION_SECTION.id && staged) {
      for (const key of ISOLATION_SETTING_KEYS) {
        if (Object.hasOwn(staged.edits, key)) isolationKeys.push(key);
      }
    }
    const turnsOnDestructive = isolationKeys.some(
      (key) =>
        DESTRUCTIVE_ISOLATION_KEYS.includes(key) &&
        isTrueSetting(staged?.edits[key]) &&
        !isTrueSetting(initial.config?.entries.find((entry) => entry.key === key)),
    );
    if (turnsOnDestructive) {
      const confirmation: IsolationSaveConfirmation = Object.freeze({
        title: "Review task isolation changes",
        message:
          "Turning these on may let future task worktrees reset source-checkout changes or apply isolated task changes automatically. Confirming saves configuration only; it does not create, clean, merge, or apply any worktree.",
        changes: isolationChanges(initial, isolationKeys),
      });
      if (!options?.confirmIsolation) return { status: "confirmation-required", confirmation };
      if (!(await options.confirmIsolation(confirmation))) {
        return { status: "cancelled", changes: confirmation.changes };
      }
      const currentSnapshot = this.runtime.getSnapshot();
      if (currentSnapshot.staged !== staged) {
        const current = currentSnapshot.staged;
        const currentIsolationKeys: IsolationSettingKey[] = [];
        if (current) {
          for (const key of ISOLATION_SETTING_KEYS) {
            if (Object.hasOwn(current.edits, key)) currentIsolationKeys.push(key);
          }
        }
        return {
          status: "stale-confirmation",
          changes: isolationChanges(currentSnapshot, currentIsolationKeys),
        };
      }
    }
    return { status: "saved", result: await this.runtime.save() };
  }
}

/** Creates a Tasks section runtime with S1.2's ConfigStore read/write and change-stream behavior. */
export function createTasksSettingsRuntime(
  client: AppClient,
  options: TasksSettingsRuntimeOptions,
): TaskSettingsSectionRuntime {
  const descriptor = TASK_SETTINGS_SECTIONS[options.section];
  const runtime = createSettingsRuntime(client, {
    descriptor,
    folder: options.folder,
    layer: options.layer,
  });
  return new TaskSettingsSectionRuntime(runtime);
}
