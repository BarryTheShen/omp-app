/**
 * Workbench's tools in every chat: the agent opens a thread for a piece of work, posts its updates and progress there,
 * asks the person there, sets its state and links what it made. The host passes each call on as an `app.threads`
 * request, saying which tool and whether the chat's own agent or a subagent called (subagents only read); the server
 * checks the call against the thread and answers it.
 */
import { z } from "zod";

export const WORK_THREAD_TOOLS = [
  "thread_open",
  "thread_read",
  "thread_update",
  "thread_ask",
  "thread_state",
  "thread_link",
] as const;
export const WorkThreadTool = z.enum(WORK_THREAD_TOOLS);
export type WorkThreadTool = z.infer<typeof WorkThreadTool>;

/** What the agent called, as the host passes it on; the server checks the params against the tool. */
export const WorkThreadToolRequest = z.strictObject({
  tool: WorkThreadTool,
  /** Who called: the chat's own agent, or a subagent of it. */
  agent: z.enum(["main", "sub"]),
  params: z.unknown(),
});
export type WorkThreadToolRequest = z.infer<typeof WorkThreadToolRequest>;
