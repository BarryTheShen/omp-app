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

  public async save(): Promise<{ readonly status: "saved"; readonly result: CommitResult }> {
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
