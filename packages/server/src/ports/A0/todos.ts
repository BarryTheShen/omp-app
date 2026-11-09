import {
  type AddTodoArgs,
  AppFailure,
  type MoveTodoArgs,
  type SetTodoMirrorArgs,
  type StreamKey,
  streamKey,
  type TodoAuthor,
  type TodoBoard,
  type TodoHistory,
  type TodoItem,
  type TodoMirror,
  TodosPort,
  type UpdateTodoArgs,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../registry/ports";
import type { SiyuanMirror } from "../../todos/siyuan-mirror";
import { TodoRefused, type TodoStore } from "../../todos/store";

export interface TodosContext {
  readonly store: TodoStore;
  /** The list's copy in SiYuan; absent: this server keeps none. */
  readonly mirror?: SiyuanMirror;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  readonly now?: () => number;
}

/** A page's change is the person's. */
const PERSON: TodoAuthor = { kind: "person" };

/** A change the list cannot take reaches the page as its own words, not as a server fault. */
async function refusedAsArgs<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TodoRefused) {
      throw new AppFailure({ code: "invalid_args", message: error.message, retryable: false });
    }
    throw error;
  }
}

/** The to-do list's port (D7): the list, its changes from pages, and `changed` to every device after each change. */
export function createTodosRuntime(context: TodosContext): {
  readonly registration: PortRegistration;
  readonly stop: () => void;
} {
  const now = context.now ?? Date.now;
  const changed = streamKey(TodosPort.name, "changed");
  const stop = context.store.subscribe((board) =>
    context.publish(changed, { revision: board.revision, at: now() }),
  );
  const { store } = context;
  const handlers = {
    list: (): TodoBoard => store.board(),
    add: (args: unknown): Promise<TodoItem> =>
      refusedAsArgs(() => store.add(args as AddTodoArgs, PERSON)),
    update: (args: unknown): Promise<TodoItem> =>
      refusedAsArgs(() => store.update(args as UpdateTodoArgs, PERSON)),
    move: async (args: unknown): Promise<null> => {
      await refusedAsArgs(() => store.move(args as MoveTodoArgs, PERSON));
      return null;
    },
    remove: async (args: unknown): Promise<null> => {
      await refusedAsArgs(() => store.remove((args as { id: string }).id, PERSON));
      return null;
    },
    history: (): TodoHistory => store.history(),
    undo: async (args: unknown): Promise<null> => {
      await refusedAsArgs(() => store.undo((args as { change: number }).change, PERSON));
      return null;
    },
    mirror: (): TodoMirror =>
      context.mirror?.state() ?? {
        address: null,
        target: null,
        tokenSaved: false,
        lastWrite: null,
      },
    setMirror: async (args: unknown): Promise<TodoMirror> => {
      const mirror = context.mirror;
      if (mirror === undefined) {
        throw new AppFailure({
          code: "unavailable",
          message: "This run of the app keeps no copy of the list in SiYuan.",
          retryable: false,
        });
      }
      try {
        return await mirror.set(args as SetTodoMirrorArgs);
      } catch (error) {
        throw new AppFailure({
          code: "invalid_args",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }
    },
  };
  return { registration: { port: TodosPort, context, handlers }, stop };
}
