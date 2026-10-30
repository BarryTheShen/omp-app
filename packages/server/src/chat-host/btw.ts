/**
 * omp's `/btw` side questions in the chat host: the `btw`, `btw_cancel` and `get_btw_history` methods and their
 * `btw_delta` / `btw_record` events. A port of omp's RPC host controller (`modes/rpc/rpc-btw.ts`, `RpcBtwController`)
 * onto omp's headless `/btw` turn (`session/btw-turn.ts`) and history store (`session/btw-history.ts`), which omp's
 * terminal uses too: one side question runs at a time against the session, its answer streams as events, and every turn
 * is checkpointed into the session's BTW history, so omp's terminal and the app read and continue the same topics.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  BtwHistoryConflictError,
  type BtwHistoryRecord,
  BtwHistoryStore,
  type BtwHistoryTurn,
  getBtwLatestTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-history";
import {
  beginBtwTurn,
  patchLatestBtwTurn,
  runBtwTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-turn";
import { toError } from "@oh-my-pi/pi-utils";
import type { BtwDeltaEvent, BtwRecordEvent } from "@omp-app/contracts/chat-host";

/** What the controller writes: the side question's events, and omp's notice when its history cannot be saved. */
type BtwOutput =
  | BtwDeltaEvent
  | BtwRecordEvent
  | { type: "notice"; level: "error"; message: string; source: "btw-history" };

interface RunningBtw {
  record: BtwHistoryRecord;
  store: BtwHistoryStore;
  abort: AbortController;
}

const CANCELLED_WHILE_STARTING = "The /btw question was cancelled before it started";

export class BtwController {
  readonly #session: Pick<AgentSession, "model" | "runEphemeralTurn" | "sessionManager">;
  readonly #output: (event: BtwOutput) => void;
  readonly #log: (line: string) => void;
  #store: BtwHistoryStore | undefined;
  /** `sessionId \0 artifactsDir` the store was opened for. */
  #storeKey: string | undefined;
  #running: RunningBtw | undefined;
  /** Topic of the `btw` request between validation and its first checkpoint (`null`: a new topic). */
  #startingTopic: string | null | undefined;
  /** Bumped by every cancel and session change; a `btw` still starting from before gives up. */
  #epoch = 0;
  /** Terminal checkpoint writes still in flight. */
  readonly #writes = new Set<Promise<void>>();
  /** Terminal checkpoints that failed, keyed by record id (latest wins); retried before any move. */
  readonly #unsaved = new Map<string, RunningBtw>();

  constructor(
    session: Pick<AgentSession, "model" | "runEphemeralTurn" | "sessionManager">,
    output: (event: BtwOutput) => void,
    log: (line: string) => void,
  ) {
    this.#session = session;
    this.#output = output;
    this.#log = log;
  }

  /**
   * Start a side question (or a follow-up in topic `recordId`); resolves once it is checkpointed as running. The turn
   * itself starts after the caller has answered.
   */
  async ask(question: string, recordId?: string): Promise<BtwHistoryRecord> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("btw requires a non-empty question");
    if (this.#startingTopic !== undefined || this.#running) {
      throw new Error("A /btw question is still running; cancel it first");
    }
    this.#startingTopic = recordId ?? null;
    const epoch = this.#epoch;
    try {
      await this.#settleWrites();
      const store = await this.#openStore(true);
      if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
      const previous =
        recordId === undefined
          ? undefined
          : store.getRecords().find((record) => record.id === recordId);
      if (recordId !== undefined && !previous) throw new Error(`Unknown /btw topic: ${recordId}`);
      if (!this.#session.model) throw new Error("No active model available for /btw.");
      const manager = this.#session.sessionManager;
      await manager.ensureOnDisk();
      if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
      const { record, history, conversationKey } = beginBtwTurn(
        trimmed,
        manager.getLeafId(),
        previous,
      );
      try {
        await store.upsert(record);
      } catch (error) {
        throw new Error(`Could not save /btw history: ${toError(error).message}`, { cause: error });
      }
      const running: RunningBtw = { record, store, abort: new AbortController() };
      this.#running = running;
      this.#output({ type: "btw_record", record });
      if (epoch !== this.#epoch) {
        // Cancelled or the session changed while the first checkpoint was written.
        this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
        throw new Error(CANCELLED_WHILE_STARTING);
      }
      // A macrotask: the `btw` answer is written first, so it never trails this turn's events.
      setTimeout(() => void this.#run(running, trimmed, history, conversationKey), 0);
      return record;
    } finally {
      this.#startingTopic = undefined;
    }
  }

  /** Cancel the running or starting question (only if it is topic `recordId`, when given). */
  cancel(recordId?: string): boolean {
    const running = this.#running;
    if (running) {
      if (recordId !== undefined && running.record.id !== recordId) return false;
      this.#epoch++;
      this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
      running.abort.abort();
      return true;
    }
    const starting = this.#startingTopic;
    if (starting === undefined || (recordId !== undefined && starting !== recordId)) return false;
    this.#epoch++;
    return true;
  }

  /** Newest first, re-read from disk when idle; a running topic carries its live partial answer. */
  async history(): Promise<readonly BtwHistoryRecord[]> {
    const store = await this.#openStore(
      this.#running === undefined && this.#startingTopic === undefined,
    );
    const running = this.#running;
    const records = new Map(store.getRecords().map((record) => [record.id, record]));
    for (const unsaved of this.#unsaved.values()) {
      if (unsaved.store === store) records.set(unsaved.record.id, unsaved.record);
    }
    if (running?.store === store) records.set(running.record.id, running.record);
    return [...records.values()].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }

  /**
   * Before the session is replaced or the chat ends: cancel the running or starting question and land every terminal
   * checkpoint. Throws, after one retry, when a checkpoint still cannot be saved, so the caller keeps the session
   * instead of losing that answer.
   */
  async close(): Promise<void> {
    this.#epoch++;
    this.cancel();
    await this.#settleWrites();
  }

  /**
   * Await terminal checkpoints, retrying failed ones once against their original revision. A retry that conflicts (the
   * topic was deleted or rewritten on disk) can never succeed: the record is reported lost and dropped instead of
   * blocking every later session change.
   */
  async #settleWrites(): Promise<void> {
    while (this.#writes.size > 0) await Promise.all(this.#writes);
    for (const [id, failed] of this.#unsaved) {
      try {
        await failed.store.retry(failed.record);
        this.#unsaved.delete(id);
      } catch (error) {
        if (error instanceof BtwHistoryConflictError) {
          this.#unsaved.delete(id);
          const message = `/btw answer ${id} was not saved: ${error.message}; it changed or was removed on disk`;
          this.#log(message);
          this.#output({ type: "notice", level: "error", message, source: "btw-history" });
          continue;
        }
        throw new Error(
          `/btw history could not be saved: ${toError(error).message}. Fix the storage and retry; unsaved answers remain in this session.`,
          { cause: error },
        );
      }
    }
  }

  /**
   * The current session's store with every queued checkpoint landed, so a just-finished turn reads as finished. `fresh`
   * re-reads a persisted store from disk, picking up topics another process (omp's terminal) wrote; callers pass it only
   * while nothing runs here. A store whose write failed (already reported) is replaced by a fresh read instead of
   * failing every later call.
   */
  async #openStore(fresh: boolean): Promise<BtwHistoryStore> {
    const manager = this.#session.sessionManager;
    const artifactsDir = manager.getArtifactsDir() ?? undefined;
    const key = `${manager.getSessionId()}\0${artifactsDir ?? ""}`;
    const cached = this.#storeKey === key ? this.#store : undefined;
    if (cached) {
      try {
        await cached.flush();
        // Without an artifacts dir the store is the only copy: never drop it.
        if (!fresh || artifactsDir === undefined) return cached;
      } catch {
        // A failed checkpoint was already reported as a `notice`; re-read from disk below.
        if ([...this.#unsaved.values()].some((unsaved) => unsaved.store === cached)) return cached;
      }
    } else if (this.#running) {
      // Replaced outside a host request (an extension switched sessions): the old session's question must not keep
      // streaming into this one's view.
      this.cancel();
    }
    const store = await BtwHistoryStore.open(artifactsDir);
    // A concurrent open for the same session already replaced the cache: keep one store.
    if (this.#storeKey === key && this.#store !== cached && this.#store !== undefined)
      return this.#store;
    this.#store = store;
    this.#storeKey = key;
    return store;
  }

  async #run(
    running: RunningBtw,
    question: string,
    history: readonly BtwHistoryTurn[] | undefined,
    conversationKey: string,
  ): Promise<void> {
    if (this.#running !== running) return;
    try {
      const { replyText } = await runBtwTurn(this.#session, {
        question,
        ...(history === undefined ? {} : { history }),
        conversationKey,
        signal: running.abort.signal,
        onTextDelta: (delta) => {
          if (this.#running !== running) return;
          const latest = getBtwLatestTurn(running.record);
          running.record = patchLatestBtwTurn(running.record, {
            answer: latest.answer + delta,
            updatedAt: Date.now(),
          });
          this.#output({ type: "btw_delta", recordId: running.record.id, delta });
        },
      });
      this.#finish(running, { answer: replyText, status: "complete", updatedAt: Date.now() });
    } catch (error) {
      this.#finish(running, {
        status: "error",
        error: toError(error).message,
        updatedAt: Date.now(),
      });
    }
  }

  /** Record the turn's terminal state once; later outcomes of the same turn are ignored. */
  #finish(running: RunningBtw, patch: Partial<BtwHistoryTurn>): void {
    if (this.#running !== running) return;
    this.#running = undefined;
    running.record = patchLatestBtwTurn(running.record, patch);
    this.#output({ type: "btw_record", record: running.record });
    const write = running.store.upsert(running.record).then(
      () => {
        this.#unsaved.delete(running.record.id);
      },
      (error: unknown) => {
        this.#unsaved.set(running.record.id, running);
        const message = `Could not save /btw history: ${toError(error).message}`;
        this.#log(message);
        this.#output({ type: "notice", level: "error", message, source: "btw-history" });
      },
    );
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }
}
