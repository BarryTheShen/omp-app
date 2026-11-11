import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";

/** The longest message a task carries: omp takes longer ones, but a queue of them is for messages, not files. */
export const TASK_TEXT_MAX = 20_000;
/** How many tasks the server keeps, waiting and done together; the oldest done ones go first. */
export const TASKS_KEPT = 200;

export const TaskId = z.string().min(1).max(64);
export type TaskId = z.infer<typeof TaskId>;

/** Where a task goes (#14): a chat, or a new chat in a folder. */
export const TaskTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat"), threadId: ThreadId }),
  z.strictObject({ kind: z.literal("new"), folder: FolderPath }),
]);
export type TaskTarget = z.infer<typeof TaskTarget>;

/**
 * When a task goes (#14): as soon as its chat is free (no turn running, not paused, not held by a usage rule), once its
 * provider's 5-hour window has reset after the task was queued, or at a time (epoch ms); in each case only once the chat
 * is free.
 */
export const TaskWhen = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("free") }),
  z.strictObject({ kind: z.literal("reset") }),
  z.strictObject({ kind: z.literal("at"), at: z.int().nonnegative() }),
]);
export type TaskWhen = z.infer<typeof TaskWhen>;

export const TaskState = z.enum(["waiting", "sent", "failed"]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * A queued message (#14). `label` is its chat's name as the page knew it when it queued the task (a new chat's: its
 * folder); `after`: for "reset", the reset the task waits for (epoch ms; null while no reading said one); `sentTo` is
 * the chat it went to (a new chat's own id); `problem` says why it failed.
 */
export const QueuedTask = z.strictObject({
  id: TaskId,
  text: z.string().min(1).max(TASK_TEXT_MAX),
  target: TaskTarget,
  label: z.string().max(200).nullable(),
  when: TaskWhen,
  after: z.int().nonnegative().nullable(),
  state: TaskState,
  createdAt: z.int().nonnegative(),
  sentAt: z.int().nonnegative().nullable(),
  sentTo: ThreadId.nullable(),
  problem: z.string().max(512).nullable(),
});
export type QueuedTask = z.infer<typeof QueuedTask>;

/** The tasks in the queue's order: the waiting ones go in it, the first first; the done ones after them, newest first. */
export const TaskListResult = z.strictObject({ tasks: z.array(QueuedTask).max(TASKS_KEPT) });
export type TaskListResult = z.infer<typeof TaskListResult>;

export const AddTaskArgs = z.strictObject({
  text: z.string().trim().min(1).max(TASK_TEXT_MAX),
  target: TaskTarget,
  label: z.string().max(200).optional(),
  when: TaskWhen,
});
export type AddTaskArgs = z.infer<typeof AddTaskArgs>;

/** Changes a waiting task's text or when it goes. */
export const UpdateTaskArgs = z.strictObject({
  id: TaskId,
  text: z.string().trim().min(1).max(TASK_TEXT_MAX).optional(),
  when: TaskWhen.optional(),
});
export type UpdateTaskArgs = z.infer<typeof UpdateTaskArgs>;

/** Moves a waiting task before another (`before`), or to the end of the waiting ones (null). */
export const MoveTaskArgs = z.strictObject({ id: TaskId, before: TaskId.nullable() });
export type MoveTaskArgs = z.infer<typeof MoveTaskArgs>;

export const TaskRef = z.strictObject({ id: TaskId });
export type TaskRef = z.infer<typeof TaskRef>;

/** The queue of messages for chats (#14): kept by the server, sent in order as each chat is free. */
export const TasksPort = definePort({
  name: "A0.tasks",
  methods: {
    list: { args: z.strictObject({}), result: TaskListResult },
    /** Queues a message; it goes as soon as its `when` comes and its chat is free. */
    add: { args: AddTaskArgs, result: TaskRef },
    update: { args: UpdateTaskArgs, result: z.null() },
    /** Removes a task: a waiting one is not sent; a done one leaves the list. */
    remove: { args: TaskRef, result: z.null() },
    move: { args: MoveTaskArgs, result: z.null() },
    /** Lets a waiting task go as soon as its chat is free, whatever its `when` said. */
    sendNow: { args: TaskRef, result: z.null() },
  },
  events: {
    /** A task was added, changed, moved, sent, failed or removed. */
    changed: { payload: z.strictObject({ at: z.number() }) },
  },
});
export type TasksPort = typeof TasksPort;
export type TasksClient = PortClient<TasksPort>;
export type TasksHandlers<Context> = PortHandlers<TasksPort, Context>;
