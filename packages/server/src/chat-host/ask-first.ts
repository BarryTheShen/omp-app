import type {
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { AskFirst as AskFirstResult } from "@omp-app/contracts/chat-host";

/** The session file's entry that keeps a chat asking first after its host starts again; it never reaches the model. */
const ASK_FIRST_ENTRY = "omp-app/ask-first";

/** omp's approval modes that let commands or file changes run unasked; a stricter one the person chose is kept. */
const LOOSER = new Set(["yolo", "write"]);

/** omp's tools that write long-term memory, which the person's other chats read (`tools/memory-*.ts`, `tools/learn.ts`). */
const MEMORY_WRITERS = new Set(["retain", "learn", "memory_edit"]);

/**
 * A chat a browser panel shows asks before commands, file changes and other actions: the pages it reads can carry
 * instructions its model may follow. This is omp's "always-ask" approval mode, which omp reads from the session's
 * settings at each tool call (`tools/approval.ts` `resolveApprovalFromContext`), so it holds from the next call on.
 * Reading stays free; a stricter mode the person chose ("always-ask-cached") is kept.
 *
 * Two read-tier routes stay closed by the hook, for the chat's own agent: messages to its subagents (`write
 * agent://…`), which omp runs without asking once their `task` call was approved (`task/executor.ts`), and long-term
 * memory, which the person's other chats read and act on.
 *
 * The entry added to the session file keeps the chat asking each time its host starts (`attach`), whichever page
 * opens it.
 */
export class AskFirst {
  #session: AgentSession | undefined;
  #on = false;

  /** The hook, given to omp with the session (`createAgentSession({ extensions })`); it runs in subagents too. */
  readonly extension: ExtensionFactory = (api) => {
    api.on("tool_call", (event, ctx) => this.#toolCall(event, ctx));
  };

  /** At the host's start: a chat once told to ask first asks again. */
  attach(session: AgentSession): void {
    this.#session = session;
    if (this.#marked(session)) this.#turnOn(session);
  }

  /** `ask_first`: the chat asks first from now on, and after every start of its host. */
  request(): AskFirstResult {
    const session = this.#session;
    if (session === undefined) throw new Error("The chat is not ready yet.");
    this.#turnOn(session);
    if (!this.#marked(session)) {
      session.sessionManager.appendCustomEntry(ASK_FIRST_ENTRY, { since: Date.now() });
    }
    return {
      approvalMode:
        cfgToolsApprovalMode.get(session.settings) === "always-ask-cached"
          ? "always-ask-cached"
          : "always-ask",
    };
  }

  #turnOn(session: AgentSession): void {
    this.#on = true;
    if (LOOSER.has(String(cfgToolsApprovalMode.get(session.settings)))) {
      cfgToolsApprovalMode.override(session.settings, "always-ask");
    }
  }

  #marked(session: AgentSession): boolean {
    return session.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === ASK_FIRST_ENTRY);
  }

  #toolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
    // Only the chat's own agent: a subagent's calls were approved with its task.
    if (!this.#on || ctx.sessionManager !== this.#session?.sessionManager) return undefined;
    const input = event.input as { readonly path?: unknown };
    if (
      event.toolName === "write" &&
      typeof input.path === "string" &&
      /^agent:\/\//i.test(input.path.trim())
    ) {
      return {
        block: true,
        reason:
          "This chat asks before it acts, and a subagent runs without asking, so it does not message subagents. Ask the person to do it from the app.",
      };
    }
    if (MEMORY_WRITERS.has(event.toolName)) {
      return {
        block: true,
        reason:
          "This chat reads web pages, so it does not write long-term memory: other chats read it and act on it. Ask the person to save it from another chat.",
      };
    }
    return undefined;
  }
}
