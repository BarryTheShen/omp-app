/**
 * The to-do list in every chat (D7): the `shared_todos` tool, which every chat has, with a page open or not. The list
 * is the server's; the tool passes the agent's call on as an `app.todos` request, saying whether the chat's own agent
 * or a subagent made it (subagents only read), and gives the agent the server's answer.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  SHARED_TODOS_TOOL,
  SharedTodosAction,
  type SharedTodosRequest,
} from "@omp-app/contracts/chat-host";
import { appToolDefinition } from "./tool-definition";
import type { HostRequests } from "./ui-context";

export const SHARED_TODOS_DESCRIPTION = [
  "The user's to-do list, shared by the user and every chat and kept across chats: their plans, things they need to do, and work to pick up later.",
  "Your own todo list is for the steps of this chat's work; this one outlives the chat.",
  "Read it before planning or when the user asks what is next; add follow-ups and future work the user asks for or that you find; mark an item doing when you start it and done when it is finished.",
  'Actions: "list" (what is to do, by list; includeDone for done ones), "add" (title; optional notes, list, due as YYYY-MM-DD), "update" (id; then any of title, notes, list, state open|doing|done, due, or null to clear it), "drop" (id: out of the way; the user can bring it back).',
  "The user sees every change with this chat's name on it. Subagents can only list.",
].join(" ");

/** The tool's parameters, as JSON Schema: plain, so every provider takes them. */
export const SHARED_TODOS_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: SharedTodosAction.options },
    id: { type: "string", description: "The item, for update and drop: the id list gives." },
    title: { type: "string", description: "One line, at most 200 characters." },
    notes: { type: "string", description: "Details, Markdown, at most 4,000 characters." },
    list: {
      type: "string",
      description: 'Which list, by name ("omp-app", "School"); new names start a list.',
    },
    state: { type: "string", enum: ["open", "doing", "done"] },
    due: { type: ["string", "null"], description: "A day as YYYY-MM-DD; null clears it." },
    includeDone: { type: "boolean", description: "For list: the done items too." },
  },
  required: ["action"],
} as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The agent's call as the server takes it: the fields it knows, each of its type; the server checks the rest. */
export function sharedTodosRequest(params: unknown, agent: "main" | "sub"): SharedTodosRequest {
  const given = (typeof params === "object" && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  const action = SharedTodosAction.safeParse(given.action);
  if (!action.success) {
    throw new Error(`shared_todos needs an action: ${SharedTodosAction.options.join(", ")}`);
  }
  const state = given.state;
  return {
    agent,
    action: action.data,
    ...(text(given.id) === undefined ? {} : { id: text(given.id) }),
    ...(text(given.title) === undefined ? {} : { title: text(given.title) }),
    ...(text(given.notes) === undefined ? {} : { notes: text(given.notes) }),
    ...(text(given.list) === undefined ? {} : { list: text(given.list) }),
    ...(state === "open" || state === "doing" || state === "done" ? { state } : {}),
    ...(given.due === null || typeof given.due === "string" ? { due: given.due } : {}),
    ...(typeof given.includeDone === "boolean" ? { includeDone: given.includeDone } : {}),
  };
}

/**
 * The tool, made before the session that holds it (omp's `customTools`); the chat's loop gives it the host's requests
 * to the server once there.
 */
export class SharedTodosTool {
  #requests: HostRequests | undefined;

  attach(requests: HostRequests): void {
    this.#requests = requests;
  }

  /** Typed as omp's `customTools` takes it, marked so omp calls it with the calling agent (`tool-definition.ts`). */
  readonly definition: ToolDefinition = appToolDefinition({
    name: SHARED_TODOS_TOOL,
    label: "Shared to-do list",
    description: SHARED_TODOS_DESCRIPTION,
    parameters: SHARED_TODOS_PARAMETERS as unknown as TSchema,
    // It changes the app's list, never the computer: an approval for it would ask about nothing on the machine.
    approval: "read",
    // Shown to the agent with its own tools, not behind a tool search.
    loadMode: "essential",
    strict: false,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const requests = this.#requests;
      if (requests === undefined) throw new Error("shared_todos is not ready yet");
      const call = sharedTodosRequest(params, ctx.agent?.kind === "sub" ? "sub" : "main");
      const sent = requests.send("app.todos", call);
      signal?.addEventListener("abort", () => requests.forget(sent.id), { once: true });
      const answer = await sent.answer;
      if (answer.isError) {
        const words = answer.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim();
        throw new Error(words || "The to-do list refused that.");
      }
      const result: AgentToolResult<unknown> = {
        content: answer.content,
        ...(answer.details === undefined ? {} : { details: answer.details }),
      };
      return result;
    },
  });
}
