import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AddTaskArgs,
  AppFailure,
  type MoveTaskArgs,
  QueuedTask,
  type StreamKey,
  streamKey,
  TASKS_KEPT,
  type TaskId,
  type TaskRef,
  TasksPort,
  type TaskTarget,
  type ThreadId,
  type UpdateTaskArgs,
} from "@omp-app/contracts";
import type { Logger } from "../../logging/logger";
import type { ProcessTimer } from "../../process/omp-process";
import type { PortRegistration } from "../../registry/ports";

/** How often waiting tasks are looked at again, for chats that became free without a turn ending (a hold released). */
export const TASKS_TICK_MS = 30_000;
/** A task waiting for a reset goes this long after it, once the provider counts the new window. */
export const TASK_RESET_GRACE_MS = 60_000;
/** After a task is sent, its chat gets no other until its turn ends, or this long at most (a turn that never said). */
export const TASK_TURN_MS = 15 * 60_000;

/** The global timer, which does not keep the server running by itself. */
const GLOBAL_TIMER: ProcessTimer = {
  setTimeout: (handler, delayMs) => {
    const handle = globalThis.setTimeout(handler, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
};

/** What sending a task's message found (#14): sent, the chat not free yet, or gone with the reason. */
export type TaskDelivery =
  | { readonly outcome: "sent"; readonly threadId: ThreadId }
  | { readonly outcome: "busy" | "paused" | "held" }
  | { readonly outcome: "gone"; readonly problem: string };

export interface TaskQueueDeps {
  readonly now: () => number;
  /** The global timer unless given (tests move theirs by hand). */
  readonly timer?: ProcessTimer;
  readonly load: () => Promise<readonly QueuedTask[]>;
  readonly save: (tasks: readonly QueuedTask[]) => Promise<void>;
  /** Sends the message, into the chat (opened again from its file if need be) or a new chat of the folder. */
  readonly deliver: (target: TaskTarget, text: string) => Promise<TaskDelivery>;
  /** When the 5-hour window of the chat's provider next resets (epoch ms), from the last reading; null: not known. */
  readonly resetOf: (threadId: ThreadId) => Promise<number | null>;
  /** Hears each change of the list. */
  readonly changed: () => void;
  readonly newId?: () => string;
  readonly logger?: Logger;
}

/** One chat's tasks go one at a time: new chats are each their own. */
const lineOf = (task: QueuedTask): string =>
  task.target.kind === "chat" ? `chat:${task.target.threadId}` : `new:${task.id}`;

/**
 * The queue of messages for chats (#14): kept on disk, sent in the queue's order as each comes due and its chat is free
 * (no turn running, not paused, not held by a usage rule), one per chat at a time: a chat's next task waits until the
 * turn the last one started has ended. Looked at again when a task changes, when a chat's turn ends, at each task's
 * time and reset, and every `TASKS_TICK_MS` while any waits.
 */
export class TaskQueue {
  readonly #deps: TaskQueueDeps;
  #tasks: QueuedTask[] = [];
  /** Chats sent a task whose turn has not ended yet, and when it was sent. */
  readonly #inFlight = new Map<string, number>();
  readonly #clock: ProcessTimer;
  #timer: unknown = null;
  #pumping = false;
  #again = false;
  #saving: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: TaskQueueDeps) {
    this.#deps = deps;
    this.#clock = deps.timer ?? GLOBAL_TIMER;
  }

  /** Takes up the tasks kept before the server started, and looks at the waiting ones. */
  async restore(): Promise<void> {
    this.#tasks = [
      ...(await this.#deps.load().catch((failure: unknown) => {
        this.#deps.logger?.warn("tasks.load_failed", { error: String(failure) });
        return [];
      })),
    ];
    void this.#pump();
  }

  /** The waiting tasks in the queue's order, then the done ones, newest first. */
  list(): readonly QueuedTask[] {
    const done = this.#tasks
      .filter((task) => task.state !== "waiting")
      .sort((a, b) => (b.sentAt ?? b.createdAt) - (a.sentAt ?? a.createdAt));
    return [...this.#waiting(), ...done];
  }

  async add(args: AddTaskArgs): Promise<TaskRef> {
    let after: number | null = null;
    if (args.when.kind === "reset") {
      if (args.target.kind !== "chat") {
        throw refused("A new chat has no provider's window yet: queue it to go now or at a time.");
      }
      after = await this.#deps.resetOf(args.target.threadId);
      if (after === null) {
        throw refused(
          "No reading of this chat's provider's 5-hour window yet: queue it to go when the chat is free, or at a time.",
        );
      }
    }
    const task = QueuedTask.parse({
      id: this.#deps.newId?.() ?? crypto.randomUUID(),
      text: args.text,
      target: args.target,
      label: args.label ?? null,
      when: args.when,
      after,
      state: "waiting",
      createdAt: this.#deps.now(),
      sentAt: null,
      sentTo: null,
      problem: null,
    });
    this.#tasks.push(task);
    this.#trim();
    this.#changed();
    void this.#pump();
    return { id: task.id };
  }

  async update(args: UpdateTaskArgs): Promise<void> {
    const task = this.#waitingTask(args.id);
    let after = task.after;
    if (args.when !== undefined && args.when.kind === "reset" && task.when.kind !== "reset") {
      if (task.target.kind !== "chat") {
        throw refused("A new chat has no provider's window yet: queue it to go now or at a time.");
      }
      after = await this.#deps.resetOf(task.target.threadId);
      if (after === null) throw refused("No reading of this chat's provider's 5-hour window yet.");
    }
    this.#replace({
      ...task,
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.when === undefined ? {} : { when: args.when }),
      after: args.when === undefined || args.when.kind === "reset" ? after : null,
    });
    this.#changed();
    void this.#pump();
  }

  remove(args: TaskRef): void {
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter((task) => task.id !== args.id);
    if (this.#tasks.length !== before) this.#changed();
  }

  /** Moves a waiting task before another waiting one, or to the end of the waiting ones. */
  move(args: MoveTaskArgs): void {
    const task = this.#waitingTask(args.id);
    const rest = this.#tasks.filter((each) => each.id !== task.id);
    const at = args.before === null ? -1 : rest.findIndex((each) => each.id === args.before);
    if (args.before !== null && at === -1) throw refused("That task is no longer in the queue.");
    if (at === -1) {
      const lastWaiting = rest.findLastIndex((each) => each.state === "waiting");
      rest.splice(lastWaiting + 1, 0, task);
    } else {
      rest.splice(at, 0, task);
    }
    this.#tasks = rest;
    this.#changed();
    void this.#pump();
  }

  /** Lets a waiting task go as soon as its chat is free, whatever its `when` said. */
  sendNow(args: TaskRef): void {
    const task = this.#waitingTask(args.id);
    this.#replace({ ...task, when: { kind: "free" }, after: null });
    this.#changed();
    void this.#pump();
  }

  /** A chat's turn ended: its next task may go. */
  onTurnEnd(threadId: ThreadId): void {
    if (this.#inFlight.delete(`chat:${threadId}`) || this.#waiting().length > 0) void this.#pump();
  }

  /** Whether a task waits to go into this chat (a task that makes a new chat names no chat yet). */
  hasWaitingFor(threadId: ThreadId): boolean {
    return this.#waiting().some(
      (task) => task.target.kind === "chat" && task.target.threadId === threadId,
    );
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** The last write's end (tests). */
  saved(): Promise<void> {
    return this.#saving;
  }

  #waiting(): QueuedTask[] {
    return this.#tasks.filter((task) => task.state === "waiting");
  }

  #waitingTask(id: TaskId): QueuedTask {
    const task = this.#tasks.find((each) => each.id === id);
    if (task === undefined) throw refused("That task is no longer in the queue.");
    if (task.state !== "waiting") throw refused("That task was already sent.");
    return task;
  }

  #replace(next: QueuedTask): void {
    this.#tasks = this.#tasks.map((task) => (task.id === next.id ? next : task));
  }

  /** Whether the task's time has come: free now, past its time, or past its reset. */
  #due(task: QueuedTask, now: number): boolean {
    switch (task.when.kind) {
      case "free":
        return true;
      case "at":
        return now >= task.when.at;
      case "reset":
        return task.after !== null && now >= task.after + TASK_RESET_GRACE_MS;
    }
  }

  async #pump(): Promise<void> {
    if (this.#closed) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        const now = this.#deps.now();
        for (const [line, at] of this.#inFlight)
          if (now - at >= TASK_TURN_MS) this.#inFlight.delete(line);
        const looked = new Set<string>();
        for (const task of this.#waiting()) {
          const line = lineOf(task);
          // A chat's first waiting task goes first; one in flight lets none of them go.
          if (looked.has(line) || this.#inFlight.has(line)) continue;
          looked.add(line);
          if (!this.#due(task, now)) continue;
          const delivery = await this.#deps.deliver(task.target, task.text).catch(
            (failure: unknown): TaskDelivery => ({
              outcome: "gone",
              problem: failure instanceof Error ? failure.message : String(failure),
            }),
          );
          if (this.#closed) return;
          if (delivery.outcome === "sent") {
            this.#inFlight.set(`chat:${delivery.threadId}`, this.#deps.now());
            this.#replace({
              ...task,
              state: "sent",
              sentAt: this.#deps.now(),
              sentTo: delivery.threadId,
            });
            this.#deps.logger?.info("tasks.sent", { task: task.id, threadId: delivery.threadId });
            this.#changed();
          } else if (delivery.outcome === "gone") {
            this.#replace({ ...task, state: "failed", problem: delivery.problem.slice(0, 512) });
            this.#deps.logger?.warn("tasks.failed", { task: task.id, problem: delivery.problem });
            this.#changed();
          }
        }
      } while (this.#again && !this.#closed);
    } finally {
      this.#pumping = false;
    }
    this.#schedule();
  }

  /** The next look: at the soonest time or reset of a waiting task, or the tick, while any waits. */
  #schedule(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    const waiting = this.#waiting();
    if (this.#closed || waiting.length === 0) return;
    const now = this.#deps.now();
    let next = now + TASKS_TICK_MS;
    for (const task of waiting) {
      const at =
        task.when.kind === "at"
          ? task.when.at
          : task.when.kind === "reset" && task.after !== null
            ? task.after + TASK_RESET_GRACE_MS
            : null;
      if (at !== null && at > now && at < next) next = at;
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.#pump();
    }, next - now);
  }

  /** Keeps every waiting task and the newest done ones, `TASKS_KEPT` in all. */
  #trim(): void {
    const room = TASKS_KEPT - this.#waiting().length;
    const keep = new Set(
      this.#tasks
        .filter((task) => task.state !== "waiting")
        .sort((a, b) => (b.sentAt ?? b.createdAt) - (a.sentAt ?? a.createdAt))
        .slice(0, Math.max(0, room))
        .map((task) => task.id),
    );
    this.#tasks = this.#tasks.filter((task) => task.state === "waiting" || keep.has(task.id));
  }

  #changed(): void {
    this.#trim();
    const tasks = [...this.#tasks];
    this.#saving = this.#saving
      .then(() => this.#deps.save(tasks))
      .catch((failure: unknown) => {
        this.#deps.logger?.warn("tasks.save_failed", { error: String(failure) });
      });
    this.#deps.changed();
  }
}

function refused(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

/** The tasks kept in `path`: `{ "version": 1, "tasks": [...] }` (none when it is missing). */
export function tasksFile(path: string): Pick<TaskQueueDeps, "load" | "save"> {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw failure;
      }
      const saved = JSON.parse(text) as { readonly version?: unknown; readonly tasks?: unknown };
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) return [];
      return saved.tasks.flatMap((task: unknown) => {
        const parsed = QueuedTask.safeParse(task);
        return parsed.success ? [parsed.data] : [];
      });
    },
    save: async (tasks) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    },
  };
}

/** The tasks' port (#14): the queue, its changes from pages, and `changed` to every device after each change. */
export function createTasksRuntime(context: {
  readonly queue: TaskQueue;
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
}): { readonly registration: PortRegistration } {
  const { queue } = context;
  const handlers = {
    list: () => ({ tasks: [...queue.list()] }),
    add: (args: unknown) => queue.add(args as AddTaskArgs),
    update: async (args: unknown) => {
      await queue.update(args as UpdateTaskArgs);
      return null;
    },
    remove: (args: unknown) => {
      queue.remove(args as TaskRef);
      return null;
    },
    move: (args: unknown) => {
      queue.move(args as MoveTaskArgs);
      return null;
    },
    sendNow: (args: unknown) => {
      queue.sendNow(args as TaskRef);
      return null;
    },
  };
  return { registration: { port: TasksPort, context, handlers } };
}

/** The stream the tasks' `changed` events go out on. */
export const TASKS_CHANGED: StreamKey = streamKey(TasksPort.name, "changed");
