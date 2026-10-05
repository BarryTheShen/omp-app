import {
  type AppError,
  AppFailure,
  type CapabilityMap,
  type PortCallOptions,
  type RpcSessionClient,
  SessionFilePath,
  SubagentId,
  type ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import {
  type AgentRef,
  AgentRefSchema,
  CancelAgentResultSchema,
  P1CapabilityKeys,
  type P1SubagentEvent,
  SubagentEventPayloadSchema,
  SubagentLifecyclePayloadSchema,
  SubagentProgressPayloadSchema,
  type SubagentTranscriptPage,
  SubagentTranscriptPageSchema,
} from "@/modules/P1/contract";
import type { OmpRuntimeStore } from "@/modules/R0/store";

export type SubagentSession = Pick<RpcSessionClient, "send" | "setSubagentSubscription">;

export type P1ClientNotification = {
  readonly seq: number;
  readonly event: P1SubagentEvent;
};

export type P1ClientNotificationListener = (notification: P1ClientNotification) => void;

export type SubscriptionLease = {
  readonly level: "progress" | "events";
  release(): Promise<void>;
};

export interface SubagentClient {
  getRoster(options?: PortCallOptions): Promise<readonly AgentRef[]>;
  readTranscript(
    subagentId: SubagentId,
    options?: {
      readonly sessionFile?: SessionFilePath;
      readonly fromByte?: number;
      readonly signal?: PortCallOptions["signal"];
    },
  ): Promise<SubagentTranscriptPage>;
  cancel(subagentId: SubagentId, options?: PortCallOptions): Promise<{ readonly cancelled: true }>;
  steer(subagentId: SubagentId, message: string, options?: PortCallOptions): Promise<void>;
  setSubscriptionLevel(
    level: "off" | "progress" | "events",
    options?: PortCallOptions,
  ): Promise<"off" | "progress" | "events">;
  acquireSubscription(
    level: "progress" | "events",
    options?: PortCallOptions,
  ): Promise<SubscriptionLease>;
  subscribeNotifications(listener: P1ClientNotificationListener): () => void;
  dispose(): Promise<void>;
}

type SubscriptionCounts = { progress: number; events: number };

function failure(
  code: AppError["code"],
  message: string,
  retryable = false,
  capability?: AppError["capability"],
): AppFailure {
  return new AppFailure({ code, message, retryable, ...(capability ? { capability } : {}) });
}

function asP1Failure(error: unknown, fallback: AppFailure): AppFailure {
  return error instanceof AppFailure ? error : fallback;
}

function requiredCapability(capabilities: CapabilityMap, key: keyof typeof P1CapabilityKeys): void {
  const capability = P1CapabilityKeys[key];
  if (capabilities[capability]?.state === "available") return;
  throw failure("unavailable", `Capability ${capability} is unavailable`, false, capability);
}

function parseSubagentId(value: string): SubagentId {
  return SubagentId.parse(value);
}

function parseSessionFile(value: string): SessionFilePath {
  return SessionFilePath.parse(value);
}

class SubagentClientImpl implements SubagentClient {
  private readonly threadId: ThreadId;
  private readonly session: SubagentSession;
  private readonly runtime: OmpRuntimeStore;
  private readonly capabilities: CapabilityMap;
  private readonly listeners = new Set<P1ClientNotificationListener>();
  private readonly notificationTypes = [
    "subagent_lifecycle",
    "subagent_progress",
    "subagent_event",
  ] as const;
  private notificationUnsubscribe: (() => void) | undefined;
  private subscriptionLevel: "off" | "progress" | "events" = "off";
  private counts: SubscriptionCounts = { progress: 0, events: 0 };
  private disposed = false;

  public constructor(options: {
    readonly threadId: ThreadId;
    readonly session: SubagentSession;
    readonly runtime: OmpRuntimeStore;
    readonly capabilities: CapabilityMap;
  }) {
    this.threadId = options.threadId;
    this.session = options.session;
    this.runtime = options.runtime;
    this.capabilities = options.capabilities;
  }

  public async getRoster(options?: PortCallOptions): Promise<readonly AgentRef[]> {
    this.ensureLive();
    requiredCapability(this.capabilities, "roster");
    try {
      const result = await this.session.send(
        { threadId: this.threadId, command: { type: "get_subagents" } },
        options,
      );
      if (!result || typeof result !== "object" || !("subagents" in result)) {
        throw failure("internal", "Subagent roster result was malformed");
      }
      const subagents = result.subagents;
      if (!Array.isArray(subagents))
        throw failure("internal", "Subagent roster result was malformed");
      return Object.freeze(
        subagents.map((snapshot) =>
          AgentRefSchema.parse({
            ...snapshot,
            id: parseSubagentId(snapshot.id),
            sessionFile: snapshot.sessionFile ? parseSessionFile(snapshot.sessionFile) : undefined,
            parentToolCallId: snapshot.parentToolCallId
              ? ToolCallId.parse(snapshot.parentToolCallId)
              : undefined,
            threadId: this.threadId,
          }),
        ),
      );
    } catch (error) {
      throw asP1Failure(error, failure("omp_error", "Subagent roster request failed", true));
    }
  }

  public async readTranscript(
    subagentId: SubagentId,
    options: {
      readonly sessionFile?: SessionFilePath;
      readonly fromByte?: number;
      readonly signal?: PortCallOptions["signal"];
    } = {},
  ): Promise<SubagentTranscriptPage> {
    this.ensureLive();
    requiredCapability(this.capabilities, "transcript");
    if (
      options.fromByte !== undefined &&
      (!Number.isInteger(options.fromByte) || options.fromByte < 0)
    ) {
      throw failure("invalid_args", "fromByte must be a non-negative integer");
    }
    try {
      const result = await this.session.send(
        {
          threadId: this.threadId,
          command: {
            type: "get_subagent_messages",
            subagentId,
            ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
            ...(options.fromByte === undefined ? {} : { fromByte: options.fromByte }),
          },
        },
        { signal: options.signal },
      );
      return SubagentTranscriptPageSchema.parse({
        ...result,
        sessionFile: parseSessionFile(result.sessionFile),
        messages: result.messages,
      });
    } catch (error) {
      throw asP1Failure(error, failure("omp_error", "Subagent transcript request failed", true));
    }
  }

  public async cancel(
    subagentId: SubagentId,
    options?: PortCallOptions,
  ): Promise<{ readonly cancelled: true }> {
    this.ensureLive();
    requiredCapability(this.capabilities, "cancel");
    try {
      const result = await this.session.send(
        { threadId: this.threadId, command: { type: "cancel_subagent", subagentId } },
        options,
      );
      const parsed = CancelAgentResultSchema.parse(result);
      if (!parsed.cancelled) {
        throw failure("not_found", "Subagent is no longer running", false);
      }
      return { cancelled: true };
    } catch (error) {
      throw asP1Failure(error, failure("omp_error", "Subagent cancel request failed", true));
    }
  }

  public async steer(
    subagentId: SubagentId,
    message: string,
    options?: PortCallOptions,
  ): Promise<void> {
    this.ensureLive();
    requiredCapability(this.capabilities, "steer");
    if (message.trim().length === 0) throw failure("invalid_args", "Steer message cannot be blank");
    try {
      await this.session.send(
        { threadId: this.threadId, command: { type: "steer_subagent", subagentId, message } },
        options,
      );
    } catch (error) {
      throw asP1Failure(error, failure("omp_error", "Subagent steer request failed", true));
    }
  }

  public async setSubscriptionLevel(
    level: "off" | "progress" | "events",
    options?: PortCallOptions,
  ): Promise<"off" | "progress" | "events"> {
    this.ensureLive();
    requiredCapability(this.capabilities, "subscription");
    if (level !== "off") requiredCapability(this.capabilities, "events");
    try {
      const result = await this.session.setSubagentSubscription(
        { threadId: this.threadId, level },
        options,
      );
      if (result.level !== level) throw failure("internal", "Subscription level was not applied");
      this.subscriptionLevel = result.level;
      return result.level;
    } catch (error) {
      throw asP1Failure(error, failure("omp_error", "Subagent subscription request failed", true));
    }
  }

  public async acquireSubscription(
    level: "progress" | "events",
    options?: PortCallOptions,
  ): Promise<SubscriptionLease> {
    this.ensureLive();
    if (level === "events") this.counts.events += 1;
    else this.counts.progress += 1;
    try {
      await this.applyDesiredLevel(options);
    } catch (error) {
      if (level === "events") this.counts.events -= 1;
      else this.counts.progress -= 1;
      throw error;
    }
    let released = false;
    return {
      level,
      release: async () => {
        if (released) return;
        released = true;
        if (level === "events") this.counts.events = Math.max(0, this.counts.events - 1);
        else this.counts.progress = Math.max(0, this.counts.progress - 1);
        await this.applyDesiredLevel();
      },
    };
  }

  public subscribeNotifications(listener: P1ClientNotificationListener): () => void {
    this.ensureLive();
    requiredCapability(this.capabilities, "events");
    this.listeners.add(listener);
    if (!this.notificationUnsubscribe) {
      this.notificationUnsubscribe = this.runtime.subscribeNotifications(
        this.notificationTypes,
        (frame, seq) => {
          this.forwardNotification(frame, seq);
        },
      );
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.notificationUnsubscribe) {
        this.notificationUnsubscribe();
        this.notificationUnsubscribe = undefined;
      }
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    const previousLevel = this.subscriptionLevel;
    this.counts = { progress: 0, events: 0 };
    if (previousLevel !== "off") {
      try {
        await this.session.setSubagentSubscription({ threadId: this.threadId, level: "off" });
        this.subscriptionLevel = "off";
      } catch {
        // Disposal cannot surface a second async failure after the client is closed.
      }
    }
    this.disposed = true;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = undefined;
    this.listeners.clear();
  }

  private ensureLive(): void {
    if (this.disposed) throw failure("cancelled", "Subagent client is disposed");
  }

  private desiredLevel(): "off" | "progress" | "events" {
    if (this.counts.events > 0) return "events";
    if (this.counts.progress > 0) return "progress";
    return "off";
  }

  private async applyDesiredLevel(options?: PortCallOptions): Promise<void> {
    const desired = this.desiredLevel();
    if (desired === this.subscriptionLevel) return;
    await this.setSubscriptionLevel(desired, options);
  }

  private forwardNotification(frame: unknown, seq: number): void {
    if (!frame || typeof frame !== "object" || !("type" in frame) || !("payload" in frame)) return;
    try {
      let event: P1SubagentEvent;
      if (frame.type === "subagent_lifecycle") {
        const parsed = SubagentLifecyclePayloadSchema.parse(frame.payload);
        event = { type: "subagent_lifecycle", payload: parsed } as P1SubagentEvent;
      } else if (frame.type === "subagent_progress") {
        const parsed = SubagentProgressPayloadSchema.parse(frame.payload);
        event = { type: "subagent_progress", payload: parsed } as P1SubagentEvent;
      } else if (frame.type === "subagent_event") {
        const parsed = SubagentEventPayloadSchema.parse(frame.payload);
        event = { type: "subagent_event", payload: parsed } as P1SubagentEvent;
      } else {
        return;
      }
      const notification = { event, seq };
      for (const listener of this.listeners) listener(notification);
    } catch {
      // R0 already validates the notification envelope; malformed payloads are not delivered.
    }
  }
}

export function createSubagentClient(options: {
  readonly threadId: ThreadId;
  readonly session: SubagentSession;
  readonly runtime: OmpRuntimeStore;
  readonly capabilities: CapabilityMap;
}): SubagentClient {
  return new SubagentClientImpl(options);
}
