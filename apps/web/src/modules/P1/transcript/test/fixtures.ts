import type { AppFailure, OmpWire } from "@omp-app/contracts";
import { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import {
  type AgentRef,
  AgentRefSchema,
  type FocusedTranscriptEvent,
  type FocusedTranscriptListener,
  type P1SubagentEvent,
  type SubagentTranscriptPage,
  SubagentTranscriptPageSchema,
} from "@/modules/P1/contract";
import type { LiveFailureListener, TranscriptFeed } from "../source";

export const threadId = ThreadId.parse("thread-p14");
export const workerId = SubagentId.parse("worker-1");
export const firstFile = SessionFilePath.parse("/workspace/artifacts/worker-1.jsonl");
export const replacedFile = SessionFilePath.parse("/workspace/artifacts/worker-1-next.jsonl");

/** An AgentRef built through the contract's own schema, so its ids are the branded ones. */
export function agentRef(overrides: Record<string, unknown> = {}): AgentRef {
  return AgentRefSchema.parse({
    id: "worker-1",
    index: 0,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: 1_759_600_000_000,
    description: "Probe the transcript",
    sessionFile: firstFile,
    threadId: "thread-p14",
    ...overrides,
  });
}

/** A user message in omp's transcript shape (the fields the converter reads). */
export function userMessage(text: string): OmpWire.AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1_759_600_000_001,
  } as unknown as OmpWire.AgentMessage;
}

/** An assistant text message in omp's transcript shape. */
export function assistantMessage(text: string): OmpWire.AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    stopReason: "stop",
    timestamp: 1_759_600_000_002,
  } as unknown as OmpWire.AgentMessage;
}

/** A custom message omp keeps for the model alone (`display: false`). */
export function hiddenMessage(): OmpWire.AgentMessage {
  return {
    role: "custom",
    customType: "todo-reminder",
    content: [{ type: "text", text: "Remember the todo list." }],
    display: false,
    timestamp: 1_759_600_000_003,
  } as unknown as OmpWire.AgentMessage;
}

/** One page of `get_subagent_messages`, validated by the contract schema. */
export function transcriptPage(input: {
  readonly file?: SessionFilePath;
  readonly fromByte: number;
  readonly nextByte: number;
  readonly messages?: readonly OmpWire.AgentMessage[];
  readonly reset?: boolean;
}): SubagentTranscriptPage {
  return SubagentTranscriptPageSchema.parse({
    sessionFile: input.file ?? firstFile,
    fromByte: input.fromByte,
    nextByte: input.nextByte,
    reset: input.reset ?? false,
    entries: [],
    messages: input.messages ?? [],
  });
}

export function lifecycleEvent(
  status: "started" | "completed" | "failed" | "aborted",
): P1SubagentEvent {
  return {
    type: "subagent_lifecycle",
    payload: {
      id: workerId,
      agent: "task",
      agentSource: "bundled",
      status,
      index: 0,
    },
  } as P1SubagentEvent;
}

export function nestedFrame(id: string): P1SubagentEvent {
  return {
    type: "subagent_event",
    payload: { id: SubagentId.parse(id), event: { type: "message_update" } },
  } as P1SubagentEvent;
}

interface PendingRead {
  readonly resolve: (page: SubagentTranscriptPage) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A transcript feed whose reads and live frames the test controls. Every read stays pending until the
 * test answers it, so the tests can check what is asked for and in what order.
 */
export class FakeFeed implements TranscriptFeed {
  public agent: AgentRef;
  public readonly requests: Array<number | undefined> = [];
  public subscriptions = 0;
  public unsubscriptions = 0;
  public subscribeError: AppFailure | undefined;
  private readonly pending: PendingRead[] = [];
  private listener: FocusedTranscriptListener | undefined;
  private liveFailureListener: LiveFailureListener | undefined;

  constructor(agent: AgentRef) {
    this.agent = agent;
  }

  public read = (options?: { readonly fromByte?: number }): Promise<SubagentTranscriptPage> => {
    this.requests.push(options?.fromByte);
    const { promise, resolve, reject } = Promise.withResolvers<SubagentTranscriptPage>();
    this.pending.push({ resolve, reject });
    return promise;
  };

  public subscribe = (
    listener: FocusedTranscriptListener,
    onFailure?: LiveFailureListener,
  ): (() => void) => {
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.subscriptions += 1;
    this.listener = listener;
    this.liveFailureListener = onFailure;
    return () => {
      this.unsubscriptions += 1;
      this.listener = undefined;
    };
  };

  public get pendingReads(): number {
    return this.pending.length;
  }

  /** Answers the oldest pending read. */
  public answer(page: SubagentTranscriptPage): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No read is pending");
    next.resolve(page);
  }

  public fail(error: unknown): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No read is pending");
    next.reject(error);
  }

  public emit(event: P1SubagentEvent): void {
    const frame: FocusedTranscriptEvent = { threadId, seq: 1, event };
    this.listener?.(frame);
  }

  public reportLiveFailure(failure: AppFailure): void {
    this.liveFailureListener?.(failure);
  }

  /** The feed a roster update would hand over: the same worker with new fields. */
  public update(overrides: Record<string, unknown>): void {
    this.agent = agentRef(overrides);
  }
}
