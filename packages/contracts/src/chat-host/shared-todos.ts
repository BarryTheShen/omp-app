/**
 * The to-do list in every chat (D7): the `shared_todos` tool, which the chat's host answers by asking the server
 * (`app.todos`). The server keeps the list; the host only passes the agent's call on, saying whether the chat's own
 * agent or a subagent made it, since subagents only read.
 */
import { z } from "zod";

export const SHARED_TODOS_TOOL = "shared_todos";

export const SharedTodosAction = z.enum(["list", "add", "update", "drop"]);
export type SharedTodosAction = z.infer<typeof SharedTodosAction>;

/** What the agent asked, as the host passes it on; the server checks each field against the list's own limits. */
export const SharedTodosRequest = z.strictObject({
  /** Who called: the chat's own agent, or a subagent of it. */
  agent: z.enum(["main", "sub"]),
  action: SharedTodosAction,
  id: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional(),
  list: z.string().optional(),
  /** Where it stands; dropping is its own action. */
  state: z.enum(["open", "doing", "done"]).optional(),
  /** A day as `YYYY-MM-DD`, or null to clear it. */
  due: z.string().nullable().optional(),
  /** For `list`: the done items too. */
  includeDone: z.boolean().optional(),
});
export type SharedTodosRequest = z.infer<typeof SharedTodosRequest>;
