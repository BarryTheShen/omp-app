/**
 * The session's subagents (SDK plan H5.2f), on omp's own channels and registries, as omp's RPC subagent registry does it
 * (18.12.6 `modes/rpc/rpc-subagents.ts`; cancel and steer: `rpc-mode.ts:783-862`).
 * - The roster keeps the running subagents from omp's lifecycle and progress channels, and remembers the transcripts
 *   of finished ones, so the app can still read them.
 * - Events go out at the subscription level the app chose: none, lifecycle and progress, or also each subagent's own
 *   session events.
 * - Only a running subagent of this session can be killed or steered.
 */
import * as fs from "node:fs/promises";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type {
  FileEntry,
  SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
  type SubagentEventPayload,
  type SubagentLifecyclePayload,
  type SubagentProgressPayload,
  TASK_SUBAGENT_EVENT_CHANNEL,
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type {
  SubagentEvent,
  SubagentMessagesParams,
  SubagentSnapshot,
  SubagentSubscriptionLevel,
  SubagentTranscript,
} from "@omp-app/contracts/chat-host";

/** How many finished subagents' transcripts stay readable, as in omp. */
const REMEMBERED_TRANSCRIPTS = 256;

/** Keeps `value` as the newest entry of a set capped at `limit`. */
function rememberNewest(set: Set<string>, value: string, limit: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.keys().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

/** Whether a report belongs to the same subagent run as the snapshot (ids repeat across parent tool calls). */
function sameRun(
  payload: Pick<
    SubagentLifecyclePayload | SubagentProgressPayload,
    "parentToolCallId" | "sessionFile"
  >,
  snapshot: SubagentSnapshot,
): boolean {
  if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
    return payload.parentToolCallId === snapshot.parentToolCallId;
  }
  if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
    return payload.sessionFile === snapshot.sessionFile;
  }
  return true;
}

/** Whole lines of a transcript from `fromByte` (`readRpcSubagentTranscript`); a missing file reads as empty. */
export async function readSubagentTranscript(
  sessionFile: string,
  fromByte = 0,
): Promise<SubagentTranscript> {
  let start = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
  let size: number;
  try {
    ({ size } = await fs.stat(sessionFile));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return {
      sessionFile,
      fromByte: start,
      nextByte: start,
      reset: false,
      entries: [],
      messages: [],
    };
  }
  // A file shorter than the offset was replaced: read it from the start.
  let reset = false;
  if (start > size) {
    start = 0;
    reset = true;
  }
  const text = start >= size ? "" : await Bun.file(sessionFile).slice(start).text();
  // A line still being written is left for the next read.
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const entries: FileEntry[] = complete.length > 0 ? parseSessionEntries(complete) : [];
  return {
    sessionFile,
    fromByte: start,
    nextByte: start + Buffer.byteLength(complete, "utf8"),
    reset,
    entries,
    messages: entries
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .map((entry) => entry.message),
  };
}

export class SubagentRoster {
  readonly #emit: (event: SubagentEvent) => void;
  #bus: EventBus | undefined;
  readonly #running = new Map<string, SubagentSnapshot>();
  /** Transcript files by subagent id, finished ones included, newest last. */
  readonly #transcripts = new Map<string, string>();
  /** Subagents of an earlier session: their late reports are dropped. */
  readonly #stale = new Set<string>();
  readonly #unsubscribe: (() => void)[];
  #unsubscribeEvents: (() => void) | undefined;
  #level: SubagentSubscriptionLevel = "off";

  constructor(bus: EventBus, emit: (event: SubagentEvent) => void) {
    this.#bus = bus;
    this.#emit = emit;
    this.#unsubscribe = [
      bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) =>
        this.#lifecycle(data as SubagentLifecyclePayload),
      ),
      bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) =>
        this.#progress(data as SubagentProgressPayload),
      ),
    ];
  }

  get level(): SubagentSubscriptionLevel {
    return this.#level;
  }

  setLevel(level: SubagentSubscriptionLevel): void {
    if (level === "events" && !this.#unsubscribeEvents && this.#bus) {
      this.#unsubscribeEvents = this.#bus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data) =>
        this.#event(data as SubagentEventPayload),
      );
    } else if (level !== "events" && this.#unsubscribeEvents) {
      this.#unsubscribeEvents();
      this.#unsubscribeEvents = undefined;
    }
    this.#level = level;
  }

  /** The running subagents, in the order they were started. */
  list(): SubagentSnapshot[] {
    return [...this.#running.values()].sort(
      (a, b) => a.index - b.index || a.id.localeCompare(b.id),
    );
  }

  /** Forgets the session's subagents after a session change; their late reports are dropped. */
  clear(): void {
    for (const id of [...this.#running.keys(), ...this.#transcripts.keys()]) {
      rememberNewest(this.#stale, id, REMEMBERED_TRANSCRIPTS);
    }
    this.#running.clear();
    this.#transcripts.clear();
  }

  dispose(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#bus = undefined;
    this.#running.clear();
    this.#transcripts.clear();
    this.#stale.clear();
  }

  /** The transcript a read may open: one of this session's subagents', never any other file. */
  transcriptFile(selector: SubagentMessagesParams): string {
    if (selector.subagentId) {
      const file =
        this.#running.get(selector.subagentId)?.sessionFile ??
        this.#transcripts.get(selector.subagentId);
      if (!file)
        throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
      return file;
    }
    if (selector.sessionFile) {
      const known =
        [...this.#running.values()].some(
          (snapshot) => snapshot.sessionFile === selector.sessionFile,
        ) || [...this.#transcripts.values()].includes(selector.sessionFile);
      if (known) return selector.sessionFile;
      throw new Error("Unknown subagent session file");
    }
    throw new Error("get_subagent_messages requires subagentId or sessionFile");
  }

  #rememberTranscript(id: string, sessionFile: string | undefined): void {
    if (!sessionFile) return;
    this.#transcripts.delete(id);
    this.#transcripts.set(id, sessionFile);
    while (this.#transcripts.size > REMEMBERED_TRANSCRIPTS) {
      const oldest = this.#transcripts.keys().next();
      if (oldest.done) break;
      this.#transcripts.delete(oldest.value);
    }
  }

  #lifecycle(payload: SubagentLifecyclePayload): void {
    const existing = this.#running.get(payload.id);
    if (existing && !sameRun(payload, existing)) return;
    if (!existing && payload.status !== "started") return;
    if (payload.status === "started") this.#stale.delete(payload.id);
    const sessionFile = payload.sessionFile ?? existing?.sessionFile;
    this.#rememberTranscript(payload.id, sessionFile);
    if (payload.status === "started") {
      const description = payload.description ?? existing?.description;
      const parentToolCallId = payload.parentToolCallId ?? existing?.parentToolCallId;
      this.#running.set(payload.id, {
        id: payload.id,
        index: payload.index,
        agent: payload.agent,
        agentSource: payload.agentSource,
        ...(description !== undefined ? { description } : {}),
        status: "running",
        ...(existing?.task !== undefined ? { task: existing.task } : {}),
        ...(existing?.assignment !== undefined ? { assignment: existing.assignment } : {}),
        ...(sessionFile !== undefined ? { sessionFile } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
        lastUpdate: Date.now(),
        ...(existing?.progress !== undefined ? { progress: existing.progress } : {}),
      });
    } else {
      this.#running.delete(payload.id);
    }
    if (this.#level !== "off") this.#emit({ type: "subagent_lifecycle", payload });
  }

  #progress(payload: SubagentProgressPayload): void {
    const { progress } = payload;
    if (this.#stale.has(progress.id)) return;
    const existing = this.#running.get(progress.id);
    if (!existing || !sameRun(payload, existing)) return;
    const sessionFile = payload.sessionFile ?? existing.sessionFile;
    this.#rememberTranscript(progress.id, sessionFile);
    const description = progress.description ?? existing.description;
    const parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
    this.#running.set(progress.id, {
      id: progress.id,
      index: payload.index,
      agent: payload.agent,
      agentSource: payload.agentSource,
      ...(description !== undefined ? { description } : {}),
      status: progress.status,
      ...(payload.task !== undefined ? { task: payload.task } : {}),
      ...(payload.assignment !== undefined ? { assignment: payload.assignment } : {}),
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      lastUpdate: Date.now(),
      progress,
    });
    if (this.#level !== "off") this.#emit({ type: "subagent_progress", payload });
  }

  #event(payload: SubagentEventPayload): void {
    if (this.#stale.has(payload.id) || this.#level !== "events") return;
    this.#emit({ type: "subagent_event", payload });
  }
}

/** A running subagent of this session, with its live session (`resolveOwnedLiveSubagent`). */
interface OwnedSubagent {
  readonly ref: AgentRef;
  readonly session: AgentSession;
}

/**
 * The roster's subagent with this id, if it still runs. Ids repeat across sessions in omp's process-wide registry, so
 * the registry's entry must carry the transcript this roster recorded; and it must still run, since it goes idle once
 * the parent accepts its result.
 */
function ownedRunning(roster: SubagentRoster, id: string): OwnedSubagent | undefined {
  const snapshot = roster.list().find((candidate) => candidate.id === id);
  if ((snapshot?.status !== "running" && snapshot?.status !== "pending") || !snapshot.sessionFile)
    return undefined;
  const ref = AgentRegistry.global().get(id);
  if (
    ref?.kind !== "sub" ||
    ref.status !== "running" ||
    !ref.session ||
    ref.sessionFile !== snapshot.sessionFile
  ) {
    return undefined;
  }
  return { ref, session: ref.session };
}

/**
 * omp's hard kill of a running subagent: the aborted tombstone first, so its result is never accepted, and the abort
 * of its session. False for one that is not running, so killing a vanished subagent is not an error.
 */
export async function cancelSubagent(roster: SubagentRoster, id: string): Promise<boolean> {
  const owned = ownedRunning(roster, id);
  if (!owned) return false;
  const [released, aborted] = await Promise.allSettled([
    AgentLifecycleManager.global().release(id, owned.ref, { tombstone: true }),
    owned.session.abort({ reason: USER_INTERRUPT_LABEL }),
  ]);
  if (released.status === "rejected") throw released.reason;
  if (aborted.status === "rejected") throw aborted.reason;
  return released.value;
}

/**
 * The app's message to a running subagent, as omp's Agent Hub chat sends it: a steering prompt on the subagent's own
 * session. Resolves once the message is accepted (queued into its turn, or its next turn started); a refusal is
 * thrown with omp's reason.
 */
export async function steerSubagent(
  roster: SubagentRoster,
  id: string,
  message: string,
  log: (line: string) => void,
): Promise<void> {
  const notRunning = new Error(`Subagent not running: ${id}`);
  const owned = ownedRunning(roster, id);
  if (!owned) throw notRunning;
  let session: AgentSession;
  try {
    session = await AgentLifecycleManager.global().ensureLive(id);
  } catch {
    throw notRunning;
  }
  // The wait above lets the subagent finish, or another of the same name take the id.
  const current = ownedRunning(roster, id);
  if (current?.ref !== owned.ref || current.session !== session) throw notRunning;
  const accepted = Promise.withResolvers<void>();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") accepted.resolve();
  });
  session.prompt(message, { streamingBehavior: "steer", throwOnDrop: true }).then(
    () => accepted.resolve(),
    (error: unknown) => {
      accepted.reject(error);
      log(
        `chat host: a message to subagent ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  try {
    await accepted.promise;
  } catch (error) {
    throw new Error(
      `Subagent refused the message: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    unsubscribe();
  }
}
