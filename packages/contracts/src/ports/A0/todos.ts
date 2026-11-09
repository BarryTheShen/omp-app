import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";

/** The longest title, notes and list name; the most items, lists and remembered changes. */
export const TODO_TITLE_MAX = 200;
export const TODO_NOTES_MAX = 4_000;
export const TODO_LIST_NAME_MAX = 40;
export const TODO_ITEMS_MAX = 2_000;
export const TODO_LISTS_MAX = 40;
export const TODO_HISTORY_MAX = 200;

/** The list an item goes to when none is named. */
export const TODO_DEFAULT_LIST = "To do";

/** Where an item stands: to do, being done, done, or dropped (kept, out of the way; it can come back). */
export const TodoState = z.enum(["open", "doing", "done", "dropped"]);
export type TodoState = z.infer<typeof TodoState>;

/** Who made a change: you (a page), a chat's agent (named by its chat), or a tick in the SiYuan mirror. */
export const TodoAuthor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person") }),
  z.strictObject({
    kind: z.literal("chat"),
    threadId: ThreadId,
    /** The chat's name when the change was made; null before omp named it. */
    title: z.string().max(200).nullable(),
  }),
  z.strictObject({ kind: z.literal("siyuan") }),
]);
export type TodoAuthor = z.infer<typeof TodoAuthor>;

const Title = z.string().trim().min(1).max(TODO_TITLE_MAX);
const Notes = z.string().max(TODO_NOTES_MAX);
const ListName = z.string().trim().min(1).max(TODO_LIST_NAME_MAX);
/** A day, as `YYYY-MM-DD`. */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** The chat an item came from, or is about, with its name when it was linked. */
const TodoChat = z.strictObject({
  threadId: ThreadId,
  folder: FolderPath.nullable(),
  title: z.string().max(200).nullable(),
});
export type TodoChat = z.infer<typeof TodoChat>;

export const TodoItem = z.strictObject({
  id: z.string().min(1).max(64),
  title: Title,
  notes: Notes,
  state: TodoState,
  list: ListName,
  due: Day.nullable(),
  chat: TodoChat.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** When it was last marked done; null while it is not done. */
  doneAt: z.number().nullable(),
  createdBy: TodoAuthor,
  updatedBy: TodoAuthor,
});
export type TodoItem = z.infer<typeof TodoItem>;

/** The list: its items in their order, the list names in use, and its revision, which every change raises. */
export const TodoBoard = z.strictObject({
  items: z.array(TodoItem),
  lists: z.array(z.string()),
  revision: z.number().int().nonnegative(),
});
export type TodoBoard = z.infer<typeof TodoBoard>;

export const TodoAction = z.enum(["add", "update", "move", "remove", "undo"]);
export type TodoAction = z.infer<typeof TodoAction>;

/** One change, as the history keeps it: the item before and after (null when it did not exist), who and when. */
export const TodoChange = z.strictObject({
  id: z.number().int().nonnegative(),
  at: z.number(),
  author: TodoAuthor,
  action: TodoAction,
  itemId: z.string(),
  title: z.string(),
  before: TodoItem.nullable(),
  after: TodoItem.nullable(),
});
export type TodoChange = z.infer<typeof TodoChange>;

export const TodoHistory = z.strictObject({ changes: z.array(TodoChange) });
export type TodoHistory = z.infer<typeof TodoHistory>;

export const AddTodoArgs = z.strictObject({
  title: Title,
  notes: Notes.optional(),
  list: ListName.optional(),
  state: TodoState.optional(),
  due: Day.nullable().optional(),
  chat: TodoChat.nullable().optional(),
});
export type AddTodoArgs = z.infer<typeof AddTodoArgs>;

export const UpdateTodoArgs = z.strictObject({
  id: z.string().min(1),
  title: Title.optional(),
  notes: Notes.optional(),
  list: ListName.optional(),
  state: TodoState.optional(),
  due: Day.nullable().optional(),
  chat: TodoChat.nullable().optional(),
});
export type UpdateTodoArgs = z.infer<typeof UpdateTodoArgs>;

export const MoveTodoArgs = z.strictObject({
  id: z.string().min(1),
  /** The item it goes before; null puts it last. */
  before: z.string().min(1).nullable(),
  /** The list it goes to; absent keeps its own. */
  list: ListName.optional(),
});
export type MoveTodoArgs = z.infer<typeof MoveTodoArgs>;

/** A SiYuan block's id: `20240101120000-abcdefg`. */
export const SiyuanBlockId = z.string().regex(/^\d{14}-[0-9a-z]{7}$/, "expected a SiYuan block id");

/** The SiYuan copy of the list as a page sees it: where it goes and how the last write went; never the token. */
export const TodoMirror = z.strictObject({
  /** SiYuan's address (`http://127.0.0.1:6806`, or an https one); null while there is no copy. */
  address: z.string().nullable(),
  /** The page or block the copy goes at the end of. */
  target: SiyuanBlockId.nullable(),
  /** Whether an API token is kept; the token itself never leaves the server. */
  tokenSaved: z.boolean(),
  lastWrite: z
    .strictObject({ at: z.number(), ok: z.boolean(), problem: z.string().nullable() })
    .nullable(),
});
export type TodoMirror = z.infer<typeof TodoMirror>;

export const SetTodoMirrorArgs = z.union([
  z.strictObject({
    address: z.url({ protocol: /^https?$/ }).max(200),
    /** Absent: the token kept before stays. */
    token: z.string().min(1).max(200).optional(),
    target: SiyuanBlockId,
  }),
  z.strictObject({ off: z.literal(true) }),
]);
export type SetTodoMirrorArgs = z.infer<typeof SetTodoMirrorArgs>;

/**
 * The to-do list (D7): one list for you and your chats' agents, kept on the server, beside each chat's own todos. Each
 * change names its author and can be taken back from the history; every device hears `changed`. A copy can be kept in
 * SiYuan, at the end of a page: ticks there count.
 */
export const TodosPort = definePort({
  name: "A0.todos",
  methods: {
    list: { args: z.strictObject({}), result: TodoBoard },
    add: { args: AddTodoArgs, result: TodoItem },
    update: { args: UpdateTodoArgs, result: TodoItem },
    move: { args: MoveTodoArgs, result: z.null() },
    /** Removes an item for good: only from a page; an agent drops it instead. */
    remove: { args: z.strictObject({ id: z.string().min(1) }), result: z.null() },
    /** The newest changes first. */
    history: { args: z.strictObject({}), result: TodoHistory },
    /** Takes a change back, when its item is still as that change left it. */
    undo: { args: z.strictObject({ change: z.number().int().nonnegative() }), result: z.null() },
    /** Where the SiYuan copy goes, and how its last write went. */
    mirror: { args: z.strictObject({}), result: TodoMirror },
    /** Sets the SiYuan copy and writes it at once, or turns it off (its block stays in SiYuan). */
    setMirror: { args: SetTodoMirrorArgs, result: TodoMirror },
  },
  events: {
    /** The list changed, from any device or chat. */
    changed: {
      payload: z.strictObject({ revision: z.number().int().nonnegative(), at: z.number() }),
    },
  },
});
export type TodosPort = typeof TodosPort;
export type TodosClient = PortClient<TodosPort>;
export type TodosHandlers<Context> = PortHandlers<TodosPort, Context>;
