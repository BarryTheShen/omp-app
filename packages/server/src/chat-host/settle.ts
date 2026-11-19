/**
 * Whether the session is done (SDK plan H5.2g1), as omp's settle report (18.22 `modes/rpc/rpc-session-settle.ts`).
 * "The agent yielded" (a yielded `agent_pause`, or the run's `agent_end`) is not "the session is done": that needs the
 * run over (omp keeps it open while a background job, a child agent or a delivery can wake it) and nothing live,
 * admitted, queued or scheduled. It backs `get_state.isSettled`, `prompt_result.sessionSettled` and the
 * `session_settled` event. The predicate is omp's own (`session/session-settle.ts`).
 */
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
  isSessionSettled,
  type SessionSettleState,
} from "@oh-my-pi/pi-coding-agent/session/session-settle";
import type { SessionSettledEvent } from "@omp-app/contracts/chat-host";

/** A turn the host decided to start but has not admitted yet (a scheduled goal continuation): not settled. */
export type ScheduledTurnProbe = () => boolean;

function nextMacrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Sends `session_settled` once per stretch of agent activity, after the run's `agent_end` and its prompt results.
 * Checked at every `agent_end` and after session changes; an open run is left alone, as its own `agent_end` checks again.
 */
export class SettleWatcher {
  readonly #session: SessionSettleState;
  readonly #emit: (event: SessionSettledEvent) => void;
  readonly #log: (line: string) => void;
  readonly #scheduledTurn: ScheduledTurnProbe | undefined;
  /** Agent activity since the last `session_settled`. */
  #active = false;
  #checking = false;
  #recheck = false;

  constructor(
    session: SessionSettleState,
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
    else if (event.type === "agent_end") void this.check();
  }

  /** Activity no `agent_start` announces (a reported pending goal turn) still ends with `session_settled`. */
  markActive(): void {
    this.#active = true;
  }

  /** Settles the stretch if the session is quiet. */
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
}
