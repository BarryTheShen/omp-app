import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  type AddTodoArgs,
  type MoveTodoArgs,
  TODO_DEFAULT_LIST,
  TODO_HISTORY_MAX,
  TODO_ITEMS_MAX,
  TODO_LISTS_MAX,
  type TodoAction,
  type TodoAuthor,
  type TodoBoard,
  TodoChange,
  type TodoHistory,
  TodoItem,
  type UpdateTodoArgs,
} from "@omp-app/contracts";
import { z } from "zod";
import { writeFileAtomic } from "../modules/A1/fs";

const FILE_NAME = "todos.json";

const Saved = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  nextChange: z.number().int().nonnegative(),
  items: z.array(TodoItem),
  history: z.array(TodoChange),
});
type Saved = z.infer<typeof Saved>;

const EMPTY: Saved = { version: 1, revision: 0, nextChange: 0, items: [], history: [] };

/** A change the list cannot take, in words for the person or the agent who asked. */
export class TodoRefused extends Error {}

export type TodoListener = (board: TodoBoard) => void;

export interface TodoStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Told when an unreadable file is moved aside, so the list starts again empty without losing it. */
  readonly onUnreadable?: (movedTo: string, reason: string) => void;
}

const same = (left: TodoItem | null, right: TodoItem | null): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** What a change did: the list after it, the item before and after (null where it did not exist), and its answer. */
interface Outcome<T> {
  readonly items: TodoItem[];
  readonly action: TodoAction;
  readonly before: TodoItem | null;
  readonly after: TodoItem | null;
  readonly result: T;
  /** Whether the history keeps it; absent means kept. */
  readonly kept?: boolean;
}

/** A change, or nothing to change (the answer as things are). */
type Applied<T> = Outcome<T> | { readonly unchanged: T };

/**
 * The to-do list (D7, `<app data>/todos.json`): one list for the person and the chats' agents, beside each chat's own
 * todos. Only this server writes the file, one change at a time. Each change raises the revision, is kept in the
 * history (the newest `TODO_HISTORY_MAX`) with its author and the item before and after, and is heard by every
 * listener, so every device and the SiYuan mirror follow it.
 */
export class TodoStore {
  readonly filePath: string;
  #saved: Saved;
  readonly #listeners = new Set<TodoListener>();
  readonly #now: () => number;
  readonly #newId: () => string;
  /** The changes in order: each reads the list as the one before left it. */
  #turn: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, saved: Saved, options: TodoStoreOptions) {
    this.filePath = filePath;
    this.#saved = saved;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** The list in `appDataDir`; a file that cannot be read is moved aside, and the list starts empty. */
  static async open(appDataDir: string, options: TodoStoreOptions = {}): Promise<TodoStore> {
    const filePath = join(appDataDir, FILE_NAME);
    let saved = EMPTY;
    const text = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text !== null) {
      const parsed = (() => {
        try {
          return Saved.safeParse(JSON.parse(text));
        } catch (error) {
          return { success: false as const, error };
        }
      })();
      if (parsed.success) saved = parsed.data;
      else {
        const movedTo = join(appDataDir, `todos.unreadable-${Date.now()}.json`);
        await rename(filePath, movedTo);
        options.onUnreadable?.(
          movedTo,
          parsed.error instanceof Error ? parsed.error.message : String(parsed.error),
        );
      }
    }
    return new TodoStore(filePath, saved, options);
  }

  board(): TodoBoard {
    const { items, revision } = this.#saved;
    return { items: [...items], lists: listsOf(items), revision };
  }

  history(): TodoHistory {
    return { changes: [...this.#saved.history].reverse() };
  }

  /** Hears every change; the returned function stops it. */
  subscribe(listener: TodoListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  add(args: AddTodoArgs, author: TodoAuthor): Promise<TodoItem> {
    return this.#change(author, (items) => {
      if (items.length >= TODO_ITEMS_MAX) {
        throw new TodoRefused(
          `The list holds ${TODO_ITEMS_MAX.toLocaleString("en-US")} items at most: remove done ones first.`,
        );
      }
      const list = args.list ?? TODO_DEFAULT_LIST;
      checkListRoom(items, list);
      const at = this.#now();
      const state = args.state ?? "open";
      const item: TodoItem = {
        id: this.#newId(),
        title: args.title,
        notes: args.notes ?? "",
        state,
        list,
        due: args.due ?? null,
        chat: args.chat ?? null,
        createdAt: at,
        updatedAt: at,
        doneAt: state === "done" ? at : null,
        createdBy: author,
        updatedBy: author,
      };
      return { items: [...items, item], action: "add", before: null, after: item, result: item };
    });
  }

  update(args: UpdateTodoArgs, author: TodoAuthor): Promise<TodoItem> {
    return this.#change<TodoItem>(author, (items) => {
      const index = indexOf(items, args.id);
      const before = items[index] as TodoItem;
      if (args.list !== undefined && args.list !== before.list) checkListRoom(items, args.list);
      const fields = {
        title: args.title ?? before.title,
        notes: args.notes ?? before.notes,
        state: args.state ?? before.state,
        list: args.list ?? before.list,
        due: args.due === undefined ? before.due : args.due,
        chat: args.chat === undefined ? before.chat : args.chat,
      };
      if (same({ ...before, ...fields }, before)) return { unchanged: before };
      const at = this.#now();
      const after: TodoItem = {
        ...before,
        ...fields,
        updatedAt: at,
        updatedBy: author,
        doneAt: fields.state !== "done" ? null : before.state === "done" ? before.doneAt : at,
      };
      const next = [...items];
      next[index] = after;
      return { items: next, action: "update", before, after, result: after };
    });
  }

  move(args: MoveTodoArgs, author: TodoAuthor): Promise<void> {
    return this.#change(author, (items) => {
      const index = indexOf(items, args.id);
      const before = items[index] as TodoItem;
      if (args.before === args.id) return { unchanged: undefined };
      const list = args.list ?? before.list;
      if (list !== before.list) checkListRoom(items, list);
      const after: TodoItem =
        list === before.list
          ? before
          : { ...before, list, updatedAt: this.#now(), updatedBy: author };
      const rest = items.filter((item) => item.id !== args.id);
      let at = rest.length;
      if (args.before !== null) {
        at = rest.findIndex((item) => item.id === args.before);
        if (at < 0) throw new TodoRefused("The item to put it before is not in the list.");
      }
      const next = [...rest.slice(0, at), after, ...rest.slice(at)];
      if (next.every((item, place) => item === items[place])) return { unchanged: undefined };
      // Only a move to another list is kept in the history: the order alone is not taken back.
      return {
        items: next,
        action: "move",
        before,
        after,
        result: undefined,
        kept: list !== before.list,
      };
    });
  }

  remove(id: string, author: TodoAuthor): Promise<void> {
    return this.#change(author, (items) => {
      const before = items[indexOf(items, id)] as TodoItem;
      return {
        items: items.filter((item) => item.id !== id),
        action: "remove",
        before,
        after: null,
        result: undefined,
      };
    });
  }

  /** Takes a change back while its item is still as the change left it; a later change to the item refuses it. */
  undo(changeId: number, author: TodoAuthor): Promise<void> {
    return this.#change(author, (items) => {
      const change = this.#saved.history.find((each) => each.id === changeId);
      if (change === undefined) throw new TodoRefused("That change is no longer in the history.");
      const index = items.findIndex((item) => item.id === change.itemId);
      const now = index < 0 ? null : (items[index] as TodoItem);
      if (!same(now, change.after)) {
        throw new TodoRefused(`"${change.title}" changed since; it cannot be taken back.`);
      }
      const restored = change.before;
      if (restored !== null && now === null && items.length >= TODO_ITEMS_MAX) {
        throw new TodoRefused(`The list holds ${TODO_ITEMS_MAX} items at most.`);
      }
      let next: TodoItem[];
      if (restored === null) next = items.filter((item) => item.id !== change.itemId);
      else if (now === null) next = [...items, restored];
      else {
        next = [...items];
        next[index] = restored;
      }
      return { items: next, action: "undo", before: now, after: restored, result: undefined };
    });
  }

  #change<T>(author: TodoAuthor, apply: (items: readonly TodoItem[]) => Applied<T>): Promise<T> {
    const work = async (): Promise<T> => {
      const current = this.#saved;
      const outcome = apply(current.items);
      if ("unchanged" in outcome) return outcome.unchanged;
      const subject = outcome.after ?? outcome.before;
      const change: TodoChange = {
        id: current.nextChange,
        at: this.#now(),
        author,
        action: outcome.action,
        itemId: subject?.id ?? "",
        title: subject?.title ?? "",
        before: outcome.before,
        after: outcome.after,
      };
      const kept = outcome.kept ?? true;
      const next: Saved = {
        version: 1,
        revision: current.revision + 1,
        nextChange: kept ? current.nextChange + 1 : current.nextChange,
        items: outcome.items,
        history: kept ? [...current.history, change].slice(-TODO_HISTORY_MAX) : current.history,
      };
      await writeFileAtomic(this.filePath, `${JSON.stringify(next)}\n`);
      this.#saved = next;
      const board = this.board();
      for (const listener of [...this.#listeners]) listener(board);
      return outcome.result;
    };
    const run = this.#turn.then(work, work);
    this.#turn = run.catch(() => undefined);
    return run;
  }
}

/** The list names in use, in the order their first items come, the default list first when it has none yet. */
function listsOf(items: readonly TodoItem[]): string[] {
  const names = [...new Set(items.map((item) => item.list))];
  return names.includes(TODO_DEFAULT_LIST) ? names : [TODO_DEFAULT_LIST, ...names];
}

function checkListRoom(items: readonly TodoItem[], list: string): void {
  const names = new Set(items.map((item) => item.list));
  if (!names.has(list) && names.size >= TODO_LISTS_MAX) {
    throw new TodoRefused(`There are ${TODO_LISTS_MAX} lists at most: use one of them.`);
  }
}

function indexOf(items: readonly TodoItem[], id: string): number {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new TodoRefused("That item is not in the list (it was removed).");
  return index;
}
