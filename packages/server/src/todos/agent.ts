import {
  AddTodoArgs,
  type FolderPath,
  type ThreadId,
  type TodoBoard,
  type TodoItem,
  UpdateTodoArgs,
} from "@omp-app/contracts";
import { SharedTodosRequest, type ToolCallAnswer } from "@omp-app/contracts/chat-host";
import type { z } from "zod";
import { TodoRefused, type TodoStore } from "./store";

/** The chat whose agent called: its id, its folder and its name now. */
export interface CallingChat {
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly title: string | null;
}

const said = (text: string): ToolCallAnswer => ({ content: [{ type: "text", text }] });
const refused = (text: string): ToolCallAnswer => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** A refused field, in a few words: "title: Too big: expected string to have <=200 characters". */
function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "call"}: ${issue.message}`)
    .join("; ");
}

/** The longest part of an item's notes the list shows an agent. */
const NOTES_SHOWN = 300;

const mark: Record<TodoItem["state"], string> = {
  open: "[ ]",
  doing: "[doing]",
  done: "[x]",
  dropped: "[dropped]",
};

/** One item as the agent reads it: its mark, title, id, due day, who added it, and the start of its notes. */
function itemLine(item: TodoItem): string {
  const parts = [`- ${mark[item.state]} ${item.title}`, `id ${item.id}`];
  if (item.due !== null) parts.push(`due ${item.due}`);
  if (item.createdBy.kind === "chat")
    parts.push(`added by the chat "${item.createdBy.title ?? item.createdBy.threadId}"`);
  const line = parts.join(" · ");
  if (item.notes === "") return line;
  const notes = item.notes.replace(/\s+/g, " ").trim();
  return `${line}\n  notes: ${notes.length > NOTES_SHOWN ? `${notes.slice(0, NOTES_SHOWN)}…` : notes}`;
}

/** The list as the agent reads it: a count, then each list's items in their order; done ones only when asked. */
export function boardText(board: TodoBoard, includeDone: boolean): string {
  const shown = board.items.filter(
    (item) =>
      item.state === "open" || item.state === "doing" || (includeDone && item.state === "done"),
  );
  const toDo = board.items.filter((item) => item.state === "open" || item.state === "doing");
  const doing = toDo.filter((item) => item.state === "doing").length;
  if (shown.length === 0) {
    return includeDone || board.items.every((item) => item.state === "dropped")
      ? "The to-do list is empty."
      : "Nothing is to do; done items are kept (includeDone shows them).";
  }
  const lines = [`${toDo.length} to do (${doing} doing). By list, in order:`];
  for (const list of board.lists) {
    const items = shown.filter((item) => item.list === list);
    if (items.length === 0) continue;
    lines.push("", list, ...items.map(itemLine));
  }
  return lines.join("\n");
}

/**
 * Answers a chat's `shared_todos` call from the list (D7). The chat's own agent may change it; a subagent only reads.
 * An agent never deletes: it drops, which the person can take back. Every change names the chat, and an item it adds
 * links back to it.
 */
export async function answerAgentCall(
  store: TodoStore,
  chat: CallingChat,
  raw: unknown,
): Promise<ToolCallAnswer> {
  const parsed = SharedTodosRequest.safeParse(raw);
  if (!parsed.success) return refused(`The call was not understood: ${issues(parsed.error)}`);
  const call = parsed.data;
  if (call.action === "list") return said(boardText(store.board(), call.includeDone === true));
  if (call.agent === "sub") {
    return refused(
      "Subagents can only list the to-do list. Put the change in your final answer, for the chat's own agent to make.",
    );
  }
  const author = { kind: "chat" as const, threadId: chat.threadId, title: chat.title };
  try {
    switch (call.action) {
      case "add": {
        const args = AddTodoArgs.safeParse({
          title: call.title,
          ...(call.notes === undefined ? {} : { notes: call.notes }),
          ...(call.list === undefined ? {} : { list: call.list }),
          ...(call.state === undefined ? {} : { state: call.state }),
          ...(call.due === undefined ? {} : { due: call.due }),
          chat: { threadId: chat.threadId, folder: chat.folder, title: chat.title },
        });
        if (!args.success) return refused(`Not added: ${issues(args.error)}`);
        const item = await store.add(args.data, author);
        return said(`Added "${item.title}" to the list "${item.list}" (id ${item.id}).`);
      }
      case "update": {
        if (call.id === undefined) return refused("update needs the item's id; list gives it.");
        const args = UpdateTodoArgs.safeParse({
          id: call.id,
          ...(call.title === undefined ? {} : { title: call.title }),
          ...(call.notes === undefined ? {} : { notes: call.notes }),
          ...(call.list === undefined ? {} : { list: call.list }),
          ...(call.state === undefined ? {} : { state: call.state }),
          ...(call.due === undefined ? {} : { due: call.due }),
        });
        if (!args.success) return refused(`Not changed: ${issues(args.error)}`);
        const item = await store.update(args.data, author);
        return said(`"${item.title}" is now: ${itemLine(item).slice(2)}.`);
      }
      case "drop": {
        if (call.id === undefined) return refused("drop needs the item's id; list gives it.");
        const item = await store.update({ id: call.id, state: "dropped" }, author);
        return said(`Dropped "${item.title}". The user can bring it back.`);
      }
    }
  } catch (error) {
    if (error instanceof TodoRefused) return refused(error.message);
    throw error;
  }
}
