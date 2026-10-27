import type { AddToolResultOptions } from "@assistant-ui/react";
import type {
  CapabilityKey,
  CapabilityMap,
  HostCallId,
  HostToolResponse,
  HostUriResponse,
  OmpWire,
  PortCallOptions,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { HostDialogAnswer } from "@omp-app/contracts/chat-host";
import type { OmpRuntimeStore, RuntimeSnapshot } from "../store/store";

export type QueueLane = "steering" | "followUp";
export type QueueDelivery = "steer" | "followUp";
export type QueueMode = OmpWire.QueueMode;
export type InterruptMode = OmpWire.InterruptMode;

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;

type QueueCommandCapability =
  | "omp.cmd.steer"
  | "omp.cmd.follow_up"
  | "omp.cmd.remove_queued_message"
  | "omp.cmd.promote_queued_message"
  | "omp.cmd.set_steering_mode"
  | "omp.cmd.set_follow_up_mode"
  | "omp.cmd.set_interrupt_mode";

export interface QueueSnapshot {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly steeringMode: QueueMode;
  readonly followUpMode: QueueMode;
  readonly interruptMode: InterruptMode;
  readonly isStreaming: boolean;
  /** Leading steering messages omp already sent into the reply; absent before omp 18.9. */
  readonly liveSteered?: number;
}

export interface QueueSubmitIntent {
  readonly text: string;
  readonly delivery: QueueDelivery;
  readonly images?: readonly OmpWire.ImageContent[];
  readonly signal?: AbortSignalLike;
}

export interface QueueItemReference {
  readonly lane: QueueLane;
  readonly message: string;
  readonly signal?: AbortSignalLike;
}

export interface QueueModeChanges {
  readonly steeringMode?: QueueMode;
  readonly followUpMode?: QueueMode;
  readonly interruptMode?: InterruptMode;
  readonly signal?: AbortSignalLike;
}

export interface QueueMutationResult {
  readonly changed: boolean;
  /** Returned only when a queued message was removed; the composer can restore these images. */
  readonly images?: readonly OmpWire.ImageContent[];
  /** omp omitted the images because the full removal response exceeded its transport limit. */
  readonly imagesDropped?: boolean;
}

export type QueueListener = (snapshot: QueueSnapshot) => void;

export interface QueuePort {
  getSnapshot(): QueueSnapshot;
  getCapabilities(): CapabilityMap;
  subscribe(listener: QueueListener): () => void;
  submit(intent: QueueSubmitIntent): Promise<void>;
  remove(item: QueueItemReference): Promise<QueueMutationResult>;
  promote(
    message: string,
    options?: { readonly signal?: AbortSignalLike },
  ): Promise<QueueMutationResult>;
  setModes(changes: QueueModeChanges): Promise<void>;
  /** Answers one of the host's dialogs, in the host's shape for its method. */
  answerDialog(id: string, answer: HostDialogAnswer, options?: PortCallOptions): Promise<void>;
  answerHostTool(response: HostToolResponse, options?: PortCallOptions): Promise<void>;
  answerHostUri(response: HostUriResponse, options?: PortCallOptions): Promise<void>;
  onAddToolResult(options: AddToolResultOptions): Promise<void>;
}

export interface QueueControllerOptions {
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  readonly capabilities?: CapabilityMap;
}

const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function internalFailure(message: string, cause: unknown): AppFailure {
  return new AppFailure({ code: "internal", message, retryable: true }, { cause });
}

function asFailure(error: unknown, fallback: string): AppFailure {
  return error instanceof AppFailure ? error : internalFailure(fallback, error);
}

function unavailable(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

function conflict(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: false });
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : "null";
  } catch {
    return "[unserializable tool result]";
  }
}

function resultContent(value: unknown): OmpWire.UserContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) {
    const content: OmpWire.UserContent[] = [];
    for (const part of value) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        content.push({
          type: "image",
          data: part.data,
          mimeType: part.mimeType,
          ...(typeof part.url === "string" ? { url: part.url } : {}),
        });
      }
    }
    if (content.length > 0) return content;
  }
  return [{ type: "text", text: safeJson(value) }];
}

function queueSnapshot(snapshot: RuntimeSnapshot): QueueSnapshot {
  return {
    steering: snapshot.queue.steering,
    followUp: snapshot.queue.followUp,
    steeringMode: snapshot.queue.steeringMode,
    followUpMode: snapshot.queue.followUpMode,
    interruptMode: snapshot.queue.interruptMode,
    liveSteered: snapshot.queue.liveSteered,
    isStreaming: snapshot.prompt.streaming,
  };
}

function commandCapability(command: QueueCommandCapability): CapabilityKey {
  return command;
}

/** R0.5's one-state queue and pending-request action controller. */
export class QueueController implements QueuePort {
  private readonly store: OmpRuntimeStore;
  private readonly send: RpcSessionSend;
  private capabilities: CapabilityMap;
  private readonly answering = new Set<string>();

  public constructor(options: QueueControllerOptions) {
    this.store = options.store;
    this.send = options.send;
    this.capabilities = options.capabilities ?? EMPTY_CAPABILITIES;
  }

  public updateCapabilities(capabilities: CapabilityMap): void {
    this.capabilities = capabilities;
  }

  public getSnapshot(): QueueSnapshot {
    return queueSnapshot(this.store.getSnapshot());
  }
  public getCapabilities(): CapabilityMap {
    return this.capabilities;
  }

  public subscribe(listener: QueueListener): () => void {
    return this.store.subscribe(() => listener(this.getSnapshot()));
  }

  public async submit(intent: QueueSubmitIntent): Promise<void> {
    if (typeof intent.text !== "string") throw invalidArgs("Queued message text is required");
    const command = intent.delivery === "steer" ? "steer" : "follow_up";
    const capability = commandCapability(`omp.cmd.${command}` as QueueCommandCapability);
    this.requireCapability(capability, "Queue submission is unavailable for this runtime");
    try {
      await this.send(
        {
          threadId: this.threadId(),
          command: {
            type: command,
            message: intent.text,
            ...(intent.images && intent.images.length > 0 ? { images: [...intent.images] } : {}),
          },
        },
        { signal: intent.signal },
      );
    } catch (error) {
      throw asFailure(error, "Queue submission failed before admission");
    }
  }

  public async remove(item: QueueItemReference): Promise<QueueMutationResult> {
    if (item.message.length === 0) throw invalidArgs("Queued message text is required");
    const capability = commandCapability("omp.cmd.remove_queued_message");
    this.requireCapability(capability, "Removing queued messages is unavailable for this runtime");
    try {
      const result = await this.send(
        {
          threadId: this.threadId(),
          command: {
            type: "remove_queued_message",
            message: item.message,
            queue: item.lane,
          },
        },
        { signal: item.signal },
      );
      const removed = isRecord(result) && result.removed === true;
      if (!removed) return { changed: false };
      const response = result as OmpWire.RemoveQueuedMessageResult;
      return {
        changed: true,
        ...(response.images ? { images: response.images } : {}),
        ...(response.imagesDropped ? { imagesDropped: true } : {}),
      };
    } catch (error) {
      throw asFailure(error, "Removing the queued message failed");
    }
  }

  public async promote(
    message: string,
    options: { readonly signal?: AbortSignalLike } = {},
  ): Promise<QueueMutationResult> {
    if (message.length === 0) throw invalidArgs("Queued message text is required");
    const capability = commandCapability("omp.cmd.promote_queued_message");
    this.requireCapability(capability, "Promoting queued messages is unavailable for this runtime");
    try {
      const result = await this.send(
        {
          threadId: this.threadId(),
          command: { type: "promote_queued_message", message },
        },
        options,
      );
      return { changed: isRecord(result) && result.promoted === true };
    } catch (error) {
      throw asFailure(error, "Promoting the queued message failed");
    }
  }

  public async setModes(changes: QueueModeChanges): Promise<void> {
    if (changes.steeringMode !== undefined) {
      await this.setMode("set_steering_mode", changes.steeringMode, changes.signal);
    }
    if (changes.followUpMode !== undefined) {
      await this.setMode("set_follow_up_mode", changes.followUpMode, changes.signal);
    }
    if (changes.interruptMode !== undefined) {
      await this.setMode("set_interrupt_mode", changes.interruptMode, changes.signal);
    }
  }

  public async answerDialog(
    id: string,
    answer: HostDialogAnswer,
    options?: PortCallOptions,
  ): Promise<void> {
    const capability = "omp.ui" as CapabilityKey;
    this.requireCapability(
      capability,
      "Answers to omp's questions are unavailable for this runtime",
    );
    if (!this.store.getSnapshot().pending.dialogs[id]) {
      throw notFound("omp no longer waits for an answer to that question");
    }
    await this.withAnswerLock(`dialog:${id}`, () => this.store.answerDialog(id, answer, options));
  }

  public async answerHostTool(
    response: HostToolResponse,
    options?: PortCallOptions,
  ): Promise<void> {
    const capability = "omp.host-tools" as CapabilityKey;
    this.requireCapability(capability, "Host tool answers are unavailable for this runtime");
    const id = response.id;
    if (!this.store.getSnapshot().pending.hostTools[id]) {
      throw notFound("The host tool request is no longer pending");
    }
    await this.withAnswerLock(`host-tool:${id}`, () =>
      this.store.answerHostTool(response, options),
    );
  }

  public async answerHostUri(response: HostUriResponse, options?: PortCallOptions): Promise<void> {
    const capability = "omp.host-uris" as CapabilityKey;
    this.requireCapability(capability, "Host URI answers are unavailable for this runtime");
    const id = response.id;
    if (!this.store.getSnapshot().pending.hostUris[id]) {
      throw notFound("The host URI request is no longer pending");
    }
    await this.withAnswerLock(`host-uri:${id}`, () => this.store.answerHostUri(response, options));
  }

  public async onAddToolResult(options: AddToolResultOptions): Promise<void> {
    const pending = Object.values(this.store.getSnapshot().pending.hostTools).find(
      (entry) => entry.request.toolCallId === options.toolCallId,
    );
    if (!pending) throw notFound("No pending host tool matches this tool call");
    const response: HostToolResponse = {
      type: "host_tool_result",
      id: pending.request.id as HostCallId,
      result: {
        content: resultContent(options.result),
        ...(options.artifact === undefined ? {} : { details: options.artifact }),
      },
      isError: options.isError,
    };
    await this.answerHostTool(response);
  }

  private threadId(): ThreadId {
    return this.store.getSnapshot().threadId;
  }

  private requireCapability(capability: CapabilityKey, message: string): void {
    if (this.capabilities[capability]?.state !== "available") {
      throw unavailable(capability, message);
    }
  }

  private async setMode(
    command: "set_steering_mode" | "set_follow_up_mode" | "set_interrupt_mode",
    mode: QueueMode | InterruptMode,
    signal?: AbortSignalLike,
  ): Promise<void> {
    const capability = commandCapability(`omp.cmd.${command}` as QueueCommandCapability);
    this.requireCapability(capability, "Queue mode changes are unavailable for this runtime");
    try {
      switch (command) {
        case "set_steering_mode":
          await this.send(
            { threadId: this.threadId(), command: { type: command, mode: mode as QueueMode } },
            { signal },
          );
          break;
        case "set_follow_up_mode":
          await this.send(
            { threadId: this.threadId(), command: { type: command, mode: mode as QueueMode } },
            { signal },
          );
          break;
        case "set_interrupt_mode":
          await this.send(
            {
              threadId: this.threadId(),
              command: { type: command, mode: mode as InterruptMode },
            },
            { signal },
          );
          break;
      }
    } catch (error) {
      throw asFailure(error, "Changing the queue mode failed");
    }
  }

  private async withAnswerLock(id: string, action: () => Promise<void>): Promise<void> {
    if (this.answering.has(id)) throw conflict("This request is already being answered");
    this.answering.add(id);
    try {
      await action();
    } finally {
      this.answering.delete(id);
    }
  }
}

export function createQueueController(options: QueueControllerOptions): QueueController {
  return new QueueController(options);
}
