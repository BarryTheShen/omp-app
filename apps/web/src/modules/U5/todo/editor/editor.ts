import type { ThreadId } from "@omp-app/contracts";
import { AppFailure, UiRequestId } from "@omp-app/contracts";
import type { ConfirmDialogRequest, EditorDialogRequest } from "@/modules/U4/contract/dialog";
import type { DialogHost } from "@/modules/U4/contract/dialog-host";
import type { TodoPhase, TodoStore } from "../contract";
import { exportTodosMarkdown, importTodosMarkdown } from "../markdown";

export interface TodoEditorOptions {
  readonly store: TodoStore;
  readonly dialogs: DialogHost;
  readonly threadId: ThreadId;
  readonly now?: () => number;
}

export type TodoEditorResult =
  | { readonly status: "saved"; readonly phases: readonly TodoPhase[] }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected" };

function requestId(prefix: string, now: () => number): ReturnType<typeof UiRequestId.parse> {
  return UiRequestId.parse(`u5-todo-${prefix}-${now()}`);
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

/** Opens U4's editor, requires an explicit replacement confirmation, then calls R0 setTodos. */
export class TodoEditorController {
  private readonly store: TodoStore;
  private readonly dialogs: DialogHost;
  private readonly threadId: ThreadId;
  private readonly now: () => number;
  private requestSequence = 0;

  public constructor(options: TodoEditorOptions) {
    this.store = options.store;
    this.dialogs = options.dialogs;
    this.threadId = options.threadId;
    this.now = options.now ?? (() => Date.now());
  }

  public async open(): Promise<TodoEditorResult> {
    const current = this.store.getSnapshot();
    const editorRequest: EditorDialogRequest = {
      kind: "editor",
      id: requestId(`edit-${++this.requestSequence}`, this.now),
      title: "Edit todo list",
      prefill: exportTodosMarkdown(current.phases),
    };
    const result = await this.dialogs.open(editorRequest, { threadId: this.threadId });
    if (result.outcome !== "answered" || result.response.kind !== "editor") {
      return { status: "cancelled" };
    }

    let phases: readonly TodoPhase[];
    try {
      phases = importTodosMarkdown(result.response.value);
    } catch (error) {
      if (error instanceof AppFailure) throw error;
      throw invalid("The todo editor produced invalid Markdown.");
    }

    const confirmRequest: ConfirmDialogRequest = {
      kind: "confirm",
      id: requestId(`replace-${++this.requestSequence}`, this.now),
      title: "Replace todo list?",
      message: "Replace the current todo list with this Markdown?",
    };
    const confirmed = await this.dialogs.confirm(confirmRequest, { threadId: this.threadId });
    if (!confirmed) return { status: "rejected" };
    return { status: "saved", phases: await this.store.setTodos(phases) };
  }
}
