import type { AppClient } from "@omp-app/client";
import type { ConfigWriteLayer, FolderPath } from "@omp-app/contracts";
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
  | "worktree.onStart"
  | "worktree.onExit"
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
  "worktree.onStart",
  "worktree.onExit",
  "task.isolation.apply",
  "task.isolation.merge",
  "task.isolation.commits",
  "worktree.base",
];

function isolationLabels(
  snapshot: SettingsRuntimeSnapshot,
  keys: readonly IsolationSettingKey[],
): readonly string[] {
  const labels: string[] = [];
  for (const key of keys) {
    let label: string | undefined;
    for (const control of snapshot.descriptor.controls) {
      if (control.key === key) {
        label = control.label;
        break;
      }
    }
    if (label === undefined) throw new Error("A task isolation change needs a confirmation label.");
    labels.push(label);
  }
  return Object.freeze(labels);
}

export interface TasksSettingsRuntimeOptions {
  readonly section: TaskSettingsSectionId;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
}

/** Adds a deny-by-default confirmation boundary around S1.2's existing ConfigStore runtime. */
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
    if (isolationKeys.length > 0) {
      const confirmation: IsolationSaveConfirmation = Object.freeze({
        title: "Review task isolation changes",
        message:
          "These settings affect future task worktrees and may enable automatic change application or source-checkout cleanup. Confirming saves configuration only; it does not create, clean, merge, or apply any worktree.",
        changes: isolationLabels(initial, isolationKeys),
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
          changes: isolationLabels(currentSnapshot, currentIsolationKeys),
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
