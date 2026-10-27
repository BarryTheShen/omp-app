/**
 * Prompt results (SDK plan H5.1). Every prompt whose answer says `resultFollows` gets exactly one `prompt_result` event,
 * sent when the run that carried the prompt yields. The rules are omp's own (18.12.6 `modes/rpc/rpc-prompt-results.ts`):
 * - a prompt dispatched as a fresh turn owns the first run that starts after it was accepted, so a late `agent_end`
 *   from an earlier run never settles it;
 * - a prompt queued into a live run (steer or follow-up) settles at the first yield after it left the queue;
 * - a prompt that reached no run before an abort is `aborted`;
 * - a run's outcome is its last assistant message's: `error` (classified as omp classifies it), `aborted`, or
 *   `completed`;
 * - an extension command that answered the prompt locally but sent the agent a message waits for that work.
 * A result is written in the next macrotask, so it always follows the response to its prompt.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { PromptFailure, PromptResultEvent } from "@omp-app/contracts/chat-host";
import { isSessionSettled, type ScheduledTurnProbe, type SettleSession } from "./settle";

/** A prompt whose result is still owed. */
export interface PromptTicket {
  readonly requestId: string;
}

/** What the results read of the session: whether a run streams, what is still queued, and whether it settled. */
export type PromptResultsSession = SettleSession;

interface RunOutcome {
  readonly status: PromptResultEvent["status"];
  readonly error?: PromptFailure;
}

interface OpenPrompt {
  /** `agent_start`s seen when the prompt was accepted; a later start begins a run the prompt may own. */
  readonly startsAtBegin: number;
  /** The outcome of the first run started after acceptance, once it yielded. */
  ownOutcome?: RunOutcome;
  /** Reached the agent while another run was live: reported at the next yield that leaves nothing queued. */
  waiting: boolean;
}

export class PromptResults {
  readonly #session: PromptResultsSession;
  readonly #emit: (event: PromptResultEvent) => void;
  readonly #scheduledTurn: ScheduledTurnProbe | undefined;
  readonly #open = new Map<PromptTicket, OpenPrompt>();
  #agentStarts = 0;

  constructor(
    session: PromptResultsSession,
    emit: (event: PromptResultEvent) => void,
    scheduledTurn?: ScheduledTurnProbe,
  ) {
    this.#session = session;
    this.#emit = emit;
    this.#scheduledTurn = scheduledTurn;
  }

  /** Opens a ticket before the prompt starts any work. Close it with exactly one report, or `discard`. */
  begin(requestId: string): PromptTicket {
    const ticket: PromptTicket = { requestId };
    this.#open.set(ticket, { startsAtBegin: this.#agentStarts, waiting: false });
    return ticket;
  }

  /** The prompt was refused or handled before it was accepted: no result is owed. */
  discard(ticket: PromptTicket): void {
    this.#open.delete(ticket);
  }

  /** The prompt's work reached the agent: reports now if its own run already yielded, otherwise when it does. */
  settle(ticket: PromptTicket): void {
    const open = this.#open.get(ticket);
    if (!open) return;
    if (open.ownOutcome) {
      this.#report(ticket, true, open.ownOutcome);
    } else if (this.#session.isStreaming || this.#agentStarts > open.startsAtBegin) {
      // Queued into a live run, or its own run paused for the agent's own follow-up work (a retry, say).
      open.waiting = true;
    } else {
      // Idle, and no run since the prompt was accepted: an abort won the race before dispatch.
      this.#report(ticket, true, { status: "aborted" });
    }
  }

  /** The prompt ended without reaching the model (an extension's command took it). */
  completeLocal(ticket: PromptTicket): void {
    this.#report(ticket, false, { status: "completed" });
  }

  /** The prompt failed after it was accepted. */
  fail(ticket: PromptTicket, message: string): void {
    this.#report(ticket, false, { status: "error", error: { message, retryable: false } });
  }

  /**
   * Marks every open prompt aborted after the session changed under it (a new chat, a branch): the change detaches the
   * run first, so the interrupted run never yields for them.
   */
  abortOpen(): void {
    for (const [ticket, open] of this.#open) {
      if (open.waiting) this.#report(ticket, true, { status: "aborted" });
      // With no run since acceptance the prompt was not detached: the command that made the change keeps it for the run
      // it starts in the new session.
      else if (this.#agentStarts > open.startsAtBegin) open.ownOutcome ??= { status: "aborted" };
    }
  }

  /** Tracks run boundaries. Call after the event was written, so a result follows its `agent_end`. */
  observe(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      this.#agentStarts++;
      return;
    }
    if (event.type !== "agent_end" || this.#open.size === 0) return;
    // A session written by an older omp has no `yielded`; there only a terminal end was a yield.
    if (!(event.yielded ?? event.isTerminal !== false)) return;
    const outcome = runOutcome(event.messages);
    // A steer or follow-up still queued has not been read by the agent yet.
    const queueDrained = this.#session.queuedMessageCount === 0;
    for (const [ticket, open] of this.#open) {
      if (open.waiting) {
        if (queueDrained) this.#report(ticket, true, outcome);
      } else if (!open.ownOutcome && this.#agentStarts > open.startsAtBegin) {
        open.ownOutcome = outcome;
      }
    }
  }

  #report(ticket: PromptTicket, agentInvoked: boolean, outcome: RunOutcome): void {
    if (!this.#open.delete(ticket)) return;
    // The next macrotask: after the prompt's own answer, and after queue drains that `sessionSettled` reads.
    setImmediate(() => {
      this.#emit({
        type: "prompt_result",
        requestId: ticket.requestId,
        agentInvoked,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        sessionSettled: isSessionSettled(this.#session, this.#scheduledTurn),
      });
    });
  }
}

/** A run's outcome, read from its last assistant message. */
function runOutcome(messages: readonly AgentMessage[]): RunOutcome {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error") return { status: "error", error: promptFailure(message) };
    if (message.stopReason === "aborted") return { status: "aborted" };
    return { status: "completed" };
  }
  return { status: "completed" };
}

function promptFailure(message: AssistantMessage): PromptFailure {
  const errorId = AIError.classifyMessage({
    api: message.api,
    provider: message.provider,
    model: message.model,
    errorId: message.errorId,
    errorMessage: message.errorMessage,
    errorClassificationMessage: message.errorClassificationMessage,
    errorStatus: message.errorStatus,
  });
  return {
    message: message.errorMessage
      ? stripRawHttpRequestDiagnostics(message.errorMessage)
      : "Provider request failed",
    provider: message.provider,
    model: message.model,
    retryable: AIError.is(errorId, AIError.Flag.Transient),
    ...(message.errorStatus !== undefined ? { httpStatus: message.errorStatus } : {}),
  };
}

interface ExtensionMessageScope {
  hasAgentMessageTask: boolean;
  readonly pending: Set<Promise<void>>;
}

/**
 * Watches messages extensions send while a prompt runs. A slash command can answer its prompt locally and still start
 * agent work (`pi.sendUserMessage()`, or `pi.sendMessage()` with a turn): that prompt's result waits for the work.
 */
export class ExtensionMessageTracker {
  readonly #scopes = new Set<ExtensionMessageScope>();

  /** An extension's send that may start a turn; the prompts running now wait for it. */
  track(task: Promise<unknown>): void {
    for (const scope of this.#scopes) {
      const scoped = task.then(
        () => {
          scope.hasAgentMessageTask = true;
        },
        () => undefined,
      );
      scope.pending.add(scoped);
      void scoped.finally(() => scope.pending.delete(scoped));
    }
  }

  watch<T>(start: () => Promise<T>): {
    readonly prompt: Promise<T>;
    readonly startedAgentWork: () => boolean;
    readonly agentWorkSent: () => Promise<void>;
  } {
    const scope: ExtensionMessageScope = { hasAgentMessageTask: false, pending: new Set() };
    this.#scopes.add(scope);
    let prompt: Promise<T>;
    try {
      prompt = start();
    } catch (error) {
      this.#scopes.delete(scope);
      throw error;
    }
    return {
      prompt: prompt.finally(() => this.#scopes.delete(scope)),
      startedAgentWork: () => scope.hasAgentMessageTask,
      agentWorkSent: async () => {
        while (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
      },
    };
  }
}

/** How a prompt start ended: admitted (its result follows), or refused before admission with the reason. */
export type PromptStart =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly error: Error };

/**
 * Starts a prompt and routes its outcome into the results. Resolves once omp admitted the prompt (its result follows), or
 * once the prompt settled without an admission: then its result follows too, unless it failed, and the failure is the
 * answer instead. Never rejects.
 */
export function startPrompt(input: {
  readonly ticket: PromptTicket;
  readonly results: PromptResults;
  readonly tracker: ExtensionMessageTracker;
  readonly run: (onPromptAdmitted: () => void) => Promise<boolean>;
}): Promise<PromptStart> {
  const answer = Promise.withResolvers<PromptStart>();
  let admitted = false;
  const onPromptAdmitted = (): void => {
    admitted = true;
    answer.resolve({ admitted: true });
  };
  let watched: ReturnType<ExtensionMessageTracker["watch"]>;
  try {
    watched = input.tracker.watch(() => input.run(onPromptAdmitted));
  } catch (cause) {
    return Promise.resolve({ admitted: false, error: toError(cause) });
  }
  watched.prompt.then(
    async (agentInvoked) => {
      if (!agentInvoked) await watched.agentWorkSent();
      if (agentInvoked || watched.startedAgentWork()) input.results.settle(input.ticket);
      else input.results.completeLocal(input.ticket);
      answer.resolve({ admitted: true });
    },
    (cause: unknown) => {
      const error = toError(cause);
      if (admitted) input.results.fail(input.ticket, error.message);
      else answer.resolve({ admitted: false, error });
    },
  );
  return answer.promise;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
