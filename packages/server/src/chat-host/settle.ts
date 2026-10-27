/**
 * Whether the session is done (SDK plan H5.2g1), as omp's settle report (18.12.6 `modes/rpc/rpc-session-settle.ts`).
 * "The agent yielded" (a terminal `agent_end`) is not "the session is done": that needs nothing live, admitted or
 * queued, and no background job or delivery that could wake the session again. It backs `get_state.isSettled`,
 * `prompt_result.sessionSettled` and the `session_settled` event.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionSettledEvent } from "@omp-app/contracts/chat-host";

export type SettleSession = Pick<
  AgentSession,
  "isStreaming" | "hasAdmittedSubmission" | "queuedMessageCount" | "hasPendingAsyncWork"
>;

/** A turn the host decided to start but has not admitted yet (a scheduled goal continuation): not settled. */
export type ScheduledTurnProbe = () => boolean;

export function isSessionSettled(
  session: SettleSession,
  scheduledTurn?: ScheduledTurnProbe,
): boolean {
  return (
    !session.isStreaming &&
    !session.hasAdmittedSubmission &&
    session.queuedMessageCount === 0 &&
    !session.hasPendingAsyncWork() &&
    scheduledTurn?.() !== true
  );
}

function nextMacrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Sends `session_settled` once per stretch of agent activity, after the final run yields and the background work that
 * would wake the session has drained. Checked at every terminal `agent_end` and after session changes.
 */
export class SettleWatcher {
  readonly #session: SettleSession & Pick<AgentSession, "settleAsyncWork">;
  readonly #emit: (event: SessionSettledEvent) => void;
  readonly #log: (line: string) => void;
  readonly #scheduledTurn: ScheduledTurnProbe | undefined;
  /** Agent activity since the last `session_settled`. */
  #active = false;
  #checking = false;
  #recheck = false;

  constructor(
    session: SettleSession & Pick<AgentSession, "settleAsyncWork">,
    emit: (event: SessionSettledEvent) => void,
    log: (line: string) => void,
    scheduledTurn?: ScheduledTurnProbe,
  ) {
    this.#session = session;
    this.#emit = emit;
    this.#log = log;
    this.#scheduledTurn = scheduledTurn;
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === "agent_start") this.#active = true;
    else if (event.type === "agent_end" && event.isTerminal !== false) void this.check();
  }

  /** Activity no `agent_start` announces (a reported pending goal turn) still ends with `session_settled`. */
  markActive(): void {
    this.#active = true;
  }

  /** Settles the stretch if the session is quiet, waiting out background work that will wake it. */
  async check(): Promise<void> {
    if (this.#checking) {
      this.#recheck = true;
      return;
    }
    this.#checking = true;
    try {
      do {
        this.#recheck = false;
        // Prompt results for this yield are written one macrotask after it; `session_settled` follows them.
        await nextMacrotask();
        await nextMacrotask();
        while (this.#active && this.#canWaitOutBackgroundWork())
          await this.#session.settleAsyncWork();
      } while (this.#recheck);
      if (!this.#active || !isSessionSettled(this.#session, this.#scheduledTurn)) return;
      this.#active = false;
      this.#emit({ type: "session_settled" });
    } catch (error) {
      this.#log(
        `chat host: the settle check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#checking = false;
    }
  }

  #canWaitOutBackgroundWork(): boolean {
    const session = this.#session;
    return !session.isStreaming && !session.hasAdmittedSubmission && session.hasPendingAsyncWork();
  }
}
