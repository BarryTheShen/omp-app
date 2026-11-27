/**
 * Workbench's tools in every chat, with a page open or not: `thread_open`, `thread_read`, `thread_update`, `thread_ask`,
 * `thread_state` and `thread_link`. The threads are the server's; each tool passes the agent's call on as an
 * `app.threads` request, saying which tool and whether the chat's own agent or a subagent made it (subagents only read),
 * and gives the agent the server's answer.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { WorkThreadTool } from "@omp-app/contracts/chat-host";
import { appToolDefinition } from "./tool-definition";
import type { HostRequests } from "./ui-context";

const ID = { type: "string", description: "The thread's id" } as const;
const PROGRESS = {
  type: "object",
  description:
    "How far the work is: done of total steps, with every step's name when you have them",
  properties: {
    done: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 1 },
    steps: { type: "array", items: { type: "string" } },
  },
  required: ["done", "total"],
} as const;

interface ThreadToolSpec {
  readonly name: WorkThreadTool;
  readonly label: string;
  readonly description: string;
  readonly parameters: object;
  /** Only reads: a subagent may call it. */
  readonly reads?: true;
}

/** The tools as the agent sees them; the server checks every field. */
export const WORK_THREAD_TOOL_SPECS: readonly ThreadToolSpec[] = [
  {
    name: "thread_open",
    label: "Open a Workbench thread",
    description: [
      "Workbench (the app's place for the user's work, one thread per bug, feature or task) keeps what you do for the user where they follow it.",
      "Open a thread for each request that is real work, then post your updates, questions and results in it (thread_update, thread_ask, thread_state, thread_link); the chat gets one line with the thread's id.",
      "Answers and messages the user writes in a thread reach you as a notice from the thread. Returns the id.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A few words: the bug or feature, as the user would name it",
        },
        kind: { type: "string", enum: ["bug", "feature", "task", "question"] },
        text: {
          type: "string",
          description: "What it is about and what done looks like, in Markdown",
        },
      },
      required: ["title", "kind", "text"],
    },
  },
  {
    name: "thread_read",
    label: "Read Workbench threads",
    description:
      "Without an id: the threads, newest activity first, with their state and owner. With an id: that thread's whole timeline. Read a thread before you take it up.",
    parameters: {
      type: "object",
      properties: {
        id: ID,
        state: { type: "string", enum: ["open", "in_progress", "waiting", "done", "closed"] },
      },
    },
    reads: true,
  },
  {
    name: "thread_update",
    label: "Post a Workbench update",
    description:
      "Posts a progress update to a thread: what was done, what was found, what is next, in Markdown; with progress, the thread's bar moves. Post when a step is done, a check passes or fails, or something ships.",
    parameters: {
      type: "object",
      properties: { id: ID, text: { type: "string" }, progress: PROGRESS },
      required: ["id", "text"],
    },
  },
  {
    name: "thread_ask",
    label: "Ask in a Workbench thread",
    description: [
      "Asks the user questions in a thread without waiting: they answer when they have time, and the answers reach this chat together as one notice from the thread.",
      "Give options for multiple choice (the user can always write their own answer), or none for a written answer; put in context why you ask, what each choice changes and your pick.",
      "Only the chat that owns the thread asks in it.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        id: ID,
        questions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Your id for the question, unique in this ask" },
              question: { type: "string" },
              header: { type: "string", description: "A short label" },
              context: {
                type: "string",
                description: "Markdown: why you ask, what each choice changes, your pick",
              },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, description: { type: "string" } },
                  required: ["label"],
                },
              },
              multi: { type: "boolean", description: "Several options may be picked" },
              recommended: {
                type: "number",
                description: "0-based index of the option you recommend",
              },
            },
            required: ["id", "question"],
          },
        },
      },
      required: ["id", "questions"],
    },
  },
  {
    name: "thread_state",
    label: "Set a Workbench thread's state",
    description:
      'Sets where a thread stands: "in_progress" while you work on it, "waiting" when it waits on the user (an answer, a test only they can run, their go), "done" when it is finished, "closed" when it is dropped.',
    parameters: {
      type: "object",
      properties: {
        id: ID,
        state: { type: "string", enum: ["open", "in_progress", "waiting", "done", "closed"] },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "thread_link",
    label: "Link to a Workbench thread",
    description:
      "Links what a thread's work made or touched: a commit (sha), a GitHub issue or any page (url), a release (version), or another chat (chat: its id).",
    parameters: {
      type: "object",
      properties: {
        id: ID,
        kind: { type: "string", enum: ["commit", "issue", "release", "url", "chat"] },
        sha: { type: "string" },
        repo: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
        version: { type: "string" },
        chat: { type: "string" },
      },
      required: ["id", "kind"],
    },
  },
];

/**
 * The tools, made before the session that holds them (omp's `customTools`); the chat's loop gives them the host's
 * requests to the server once there.
 */
export class WorkThreadTools {
  #requests: HostRequests | undefined;

  attach(requests: HostRequests): void {
    this.#requests = requests;
  }

  /** Typed as omp's `customTools` takes them, marked so omp calls them with the calling agent (`tool-definition.ts`). */
  readonly definitions: readonly ToolDefinition[] = WORK_THREAD_TOOL_SPECS.map((spec) =>
    appToolDefinition({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters as unknown as TSchema,
      // They change the app's threads, never the computer: an approval would ask about nothing on the machine.
      approval: "read",
      // Shown to the agent with its own tools, not behind a tool search.
      loadMode: "essential",
      strict: false,
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const requests = this.#requests;
        if (requests === undefined) throw new Error(`${spec.name} is not ready yet`);
        const sent = requests.send("app.threads", {
          tool: spec.name,
          agent: ctx.agent?.kind === "sub" ? "sub" : "main",
          params,
        });
        signal?.addEventListener("abort", () => requests.forget(sent.id), { once: true });
        const answer = await sent.answer;
        if (answer.isError) {
          const words = answer.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim();
          throw new Error(words || "Workbench refused that.");
        }
        const result: AgentToolResult<unknown> = {
          content: answer.content,
          ...(answer.details === undefined ? {} : { details: answer.details }),
        };
        return result;
      },
    }),
  );
}
