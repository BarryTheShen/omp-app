import type { TodoPhase, TodoReminderMetadata, TodoSnapshot, TodoStore } from "../contract";

export interface TodoReminderTimer {
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface TodoReminderSnapshot {
  readonly reminder: TodoReminderMetadata | null;
  readonly badgeCount: number;
  readonly cleared: boolean;
  readonly previousPhases: readonly TodoPhase[] | null;
  readonly sequence: number;
}

export type TodoReminderListener = (snapshot: TodoReminderSnapshot) => void;

export interface TodoReminderControllerOptions {
  readonly store: TodoStore;
  readonly timer?: TodoReminderTimer;
  readonly retentionMs?: number;
}

const defaultTimer: TodoReminderTimer = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const EMPTY_SNAPSHOT: TodoReminderSnapshot = Object.freeze({
  reminder: null,
  badgeCount: 0,
  cleared: false,
  previousPhases: null,
  sequence: 0,
});

function copyPhases(phases: readonly TodoPhase[]): readonly TodoPhase[] {
  return Object.freeze(
    phases.map((phase) =>
      Object.freeze({
        name: phase.name,
        tasks: Object.freeze(
          phase.tasks.map((task) =>
            Object.freeze({
              content: task.content,
              status: task.status,
              ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
              ...(task.details === undefined ? {} : { details: task.details }),
              ...(task.notes === undefined ? {} : { notes: Object.freeze([...task.notes]) }),
            }),
          ),
        ),
      }),
    ),
  ) as unknown as readonly TodoPhase[];
}

/** Keeps reminder/auto-clear state passive and derived from the one U5.3 TodoStore. */
export class TodoReminderController {
  private readonly timer: TodoReminderTimer;
  private readonly retentionMs: number;
  private readonly listeners = new Set<TodoReminderListener>();
  private readonly unsubscribe: () => void;
  private snapshot: TodoReminderSnapshot = EMPTY_SNAPSHOT;
  private previousStoreSnapshot: TodoSnapshot;
  private expiry: unknown;

  public constructor(options: TodoReminderControllerOptions) {
    this.timer = options.timer ?? defaultTimer;
    this.retentionMs = options.retentionMs ?? 30_000;
    this.previousStoreSnapshot = options.store.getSnapshot();
    this.snapshot = this.derive(this.previousStoreSnapshot, false, null);
    this.unsubscribe = options.store.subscribe(this.onStoreSnapshot);
  }

  public getSnapshot(): TodoReminderSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: TodoReminderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dismissCleared(): void {
    if (!this.snapshot.cleared) return;
    this.clearExpiry();
    this.snapshot = Object.freeze({ ...this.snapshot, cleared: false, previousPhases: null });
    this.notify();
  }

  public dispose(): void {
    this.clearExpiry();
    this.unsubscribe();
    this.listeners.clear();
  }

  private readonly onStoreSnapshot = (next: TodoSnapshot): void => {
    const wasPopulated = this.previousStoreSnapshot.phases.length > 0;
    const isCleared = wasPopulated && next.phases.length === 0;
    const previous = isCleared
      ? copyPhases(this.previousStoreSnapshot.phases)
      : this.snapshot.previousPhases;
    this.previousStoreSnapshot = next;
    if (isCleared) this.scheduleExpiry();
    this.snapshot = this.derive(next, isCleared, previous);
    this.notify();
  };

  private derive(
    snapshot: TodoSnapshot,
    cleared: boolean,
    previousPhases: readonly TodoPhase[] | null,
  ): TodoReminderSnapshot {
    const reminder = snapshot.reminder;
    return Object.freeze({
      reminder,
      badgeCount: reminder?.todos.length ?? 0,
      cleared,
      previousPhases,
      sequence: snapshot.sequence,
    });
  }

  private scheduleExpiry(): void {
    this.clearExpiry();
    this.expiry = this.timer.setTimeout(() => {
      this.expiry = undefined;
      if (!this.snapshot.cleared) return;
      this.snapshot = Object.freeze({ ...this.snapshot, cleared: false, previousPhases: null });
      this.notify();
    }, this.retentionMs);
  }

  private clearExpiry(): void {
    if (this.expiry === undefined) return;
    this.timer.clearTimeout(this.expiry);
    this.expiry = undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export interface TodoReminderNoticeProps {
  readonly snapshot: TodoReminderSnapshot;
  readonly onViewPrevious?: () => void;
  readonly onDismissCleared?: () => void;
}
