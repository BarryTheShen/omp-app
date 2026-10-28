import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  QueueItemState,
} from "@assistant-ui/react";
import type { CapabilityKey, CapabilityMap, Omp } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type {
  QueueItemReference,
  QueueLane,
  QueueModeChanges,
  QueueMutationResult,
  QueuePort,
  QueueSnapshot,
  QueueSubmitIntent,
} from "../../R0/actions/actions";

export type { QueueLane, QueueModeChanges, QueueMutationResult, QueuePort, QueueSnapshot };

export const P6_QUEUE_CAPABILITIES = {
  steer: "omp.cmd.steer" as CapabilityKey,
  followUp: "omp.cmd.follow_up" as CapabilityKey,
  remove: "omp.cmd.remove_queued_message" as CapabilityKey,
  promote: "omp.cmd.promote_queued_message" as CapabilityKey,
  steeringMode: "omp.cmd.set_steering_mode" as CapabilityKey,
  followUpMode: "omp.cmd.set_follow_up_mode" as CapabilityKey,
  interruptMode: "omp.cmd.set_interrupt_mode" as CapabilityKey,
  reorder: "upstream.queue-reorder" as CapabilityKey,
  edit: "upstream.queue-edit" as CapabilityKey,
} as const;

export type QueueItemStatus = "queued" | "sent";

export interface QueueItemView extends QueueItemState {
  readonly lane: QueueLane;
  readonly status: QueueItemStatus;
  readonly canRemove: boolean;
  readonly canPromote: boolean;
}

export interface QueueAdapterSnapshot {
  readonly items: readonly QueueItemView[];
  readonly steerItems: readonly QueueItemView[];
  /** Leading steering messages omp already sent into the reply: `remove_queued_message` cannot reach them. */
  readonly liveSteered: number;
  readonly steeringMode: QueueSnapshot["steeringMode"];
  readonly followUpMode: QueueSnapshot["followUpMode"];
  readonly interruptMode: QueueSnapshot["interruptMode"];
  readonly isStreaming: boolean;
  readonly capabilities: CapabilityMap;
  readonly lastError?: AppFailure;
}
type LocatedQueueItem = QueueItemReference & { readonly status: QueueItemStatus };

export type QueueAdapterErrorHandler = (error: AppFailure) => void;

export interface QueueAdapterOptions {
  readonly onError?: QueueAdapterErrorHandler;
}

export interface QueueAdapterController {
  /** Stable object consumed by assistant-ui's ExternalStore runtime. */
  readonly adapter: ExternalThreadQueueAdapter;
  getSnapshot(): QueueAdapterSnapshot;
  subscribe(listener: (snapshot: QueueAdapterSnapshot) => void): () => void;
  /** Removes an item and returns content that is no longer represented in the queue snapshot. */
  removeForEdit(queueItemId: string): Promise<QueueMutationResult>;
  dispose(): void;
}

function asFailure(error: unknown, fallback: string): AppFailure {
  return error instanceof AppFailure
    ? error
    : new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error });
}

function unavailable(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

function textParts(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function imageParts(message: AppendMessage): readonly Omp.ImageContent[] | undefined {
  if (typeof message.content === "string") return undefined;
  const images: Omp.ImageContent[] = [];
  for (const part of message.content) {
    if (part.type !== "image") continue;
    const data = part.image;
    images.push({ type: "image", data, mimeType: "image/*", url: data });
  }
  return images.length > 0 ? images : undefined;
}

function submitIntent(
  message: AppendMessage,
  delivery: QueueSubmitIntent["delivery"],
): QueueSubmitIntent {
  const text = textParts(message);
  const images = imageParts(message);
  return {
    text,
    delivery,
    ...(images ? { images } : {}),
  };
}

function itemId(lane: QueueLane, message: string, occurrence: number): string {
  return `p6:${lane}:${encodeURIComponent(message)}:${occurrence}`;
}

function queueItem(lane: QueueLane, message: string, occurrence: number): QueueItemView {
  return {
    id: itemId(lane, message, occurrence),
    prompt: message,
    parts: [{ type: "text", text: message }],
    lane,
    status: "queued",
    canRemove: false,
    canPromote: false,
  };
}

function hasCapability(capabilities: CapabilityMap, capability: CapabilityKey): boolean {
  return capabilities[capability]?.state === "available";
}

function viewItems(
  lane: QueueLane,
  messages: readonly string[],
  capabilities: CapabilityMap,
  liveSteered = 0,
): readonly QueueItemView[] {
  const occurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const occurrence = occurrences.get(message) ?? 0;
    occurrences.set(message, occurrence + 1);
    const sent = lane === "steering" && index < liveSteered;
    return {
      ...queueItem(lane, message, occurrence),
      status: sent ? "sent" : "queued",
      canRemove: !sent && hasCapability(capabilities, P6_QUEUE_CAPABILITIES.remove),
      canPromote: lane === "followUp" && hasCapability(capabilities, P6_QUEUE_CAPABILITIES.promote),
    };
  });
}

function placementLane(placement: { readonly lane?: "queue" | "steer" }): QueueLane | undefined {
  if (placement.lane === "steer") return "steering";
  if (placement.lane === "queue") return "followUp";
  return undefined;
}

export function createQueueAdapter(
  port: QueuePort,
  options: QueueAdapterOptions = {},
): QueueAdapterController {
  const listeners = new Set<(snapshot: QueueAdapterSnapshot) => void>();
  let lastError: AppFailure | undefined;
  const report = (error: unknown, fallback: string): void => {
    lastError = asFailure(error, fallback);
    options.onError?.(lastError);
    const next = getSnapshot();
    for (const listener of [...listeners]) listener(next);
  };
  const getSnapshot = (): QueueAdapterSnapshot => {
    const snapshot = port.getSnapshot();
    const capabilities = port.getCapabilities();
    return {
      items: viewItems("followUp", snapshot.followUp, capabilities),
      steerItems: viewItems("steering", snapshot.steering, capabilities, snapshot.liveSteered ?? 0),
      liveSteered: snapshot.liveSteered ?? 0,
      steeringMode: snapshot.steeringMode,
      followUpMode: snapshot.followUpMode,
      interruptMode: snapshot.interruptMode,
      isStreaming: snapshot.isStreaming,
      capabilities,
      ...(lastError ? { lastError } : {}),
    };
  };
  const findItem = (id: string): LocatedQueueItem | undefined => {
    const snapshot = port.getSnapshot();
    for (const [lane, messages] of [
      ["steering", snapshot.steering],
      ["followUp", snapshot.followUp],
    ] as const) {
      const occurrences = new Map<string, number>();
      for (const [index, message] of messages.entries()) {
        const occurrence = occurrences.get(message) ?? 0;
        occurrences.set(message, occurrence + 1);
        if (itemId(lane, message, occurrence) === id) {
          return {
            lane,
            message,
            status: lane === "steering" && index < (snapshot.liveSteered ?? 0) ? "sent" : "queued",
          };
        }
      }
    }
    return undefined;
  };
  const enqueue = (message: AppendMessage): void => {
    void port
      .submit(submitIntent(message, "followUp"))
      .catch((error) => report(error, "Queueing the follow-up failed"));
  };
  const steer = (message: AppendMessage): void => {
    void port
      .submit(submitIntent(message, "steer"))
      .catch((error) => report(error, "Steering the running turn failed"));
  };
  const move = (
    id: string,
    placement: {
      readonly lane?: "queue" | "steer";
      readonly insertAfter?: string | null;
      readonly insertBefore?: string | null;
    },
  ): void => {
    const item = findItem(id);
    const lane = placementLane(placement);
    const anchored = placement.insertAfter !== undefined || placement.insertBefore !== undefined;
    if (!item) {
      report(
        notFound("The queued message is no longer present"),
        "The queued message is no longer present",
      );
      return;
    }
    if (lane === "steering" && item.lane === "followUp" && !anchored) {
      void port
        .promote(item.message)
        .catch((error) => report(error, "Promoting the queued message failed"));
      return;
    }
    if (!anchored && (lane === undefined || lane === item.lane)) return;
    report(
      unavailable(
        P6_QUEUE_CAPABILITIES.reorder,
        "Queue reordering is unavailable for this omp runtime",
      ),
      "Queue reordering is unavailable for this omp runtime",
    );
  };
  const edit = (id: string, _message: AppendMessage): void => {
    if (!findItem(id)) {
      report(
        notFound("The queued message is no longer present"),
        "The queued message is no longer present",
      );
      return;
    }
    report(
      unavailable(
        P6_QUEUE_CAPABILITIES.edit,
        "Editing queued messages is unavailable for this omp runtime",
      ),
      "Editing queued messages is unavailable for this omp runtime",
    );
  };
  const removeForEdit = async (id: string): Promise<QueueMutationResult> => {
    const item = findItem(id);
    if (!item) throw notFound("The queued message is no longer present");
    if (item.status === "sent") {
      throw new AppFailure({
        code: "conflict",
        message:
          "omp already sent this steering message into the reply; it cannot be returned to the message box.",
        retryable: false,
      });
    }
    const result = await port.remove({ lane: item.lane, message: item.message });
    if (!result.changed) {
      throw new AppFailure({
        code: "conflict",
        message: "omp did not remove this message. It may already be part of the reply.",
        retryable: false,
      });
    }
    return result;
  };
  const remove = (id: string): void => {
    const item = findItem(id);
    if (!item) {
      report(
        notFound("The queued message is no longer present"),
        "The queued message is no longer present",
      );
      return;
    }
    if (item.status === "sent") {
      report(
        new AppFailure({
          code: "conflict",
          message: "omp already sent this steering message into the reply.",
          retryable: false,
        }),
        "Removing the queued message failed",
      );
      return;
    }
    void port
      .remove({ lane: item.lane, message: item.message })
      .then((result) => {
        if (!result.changed) {
          report(
            new AppFailure({
              code: "conflict",
              message: "omp did not remove this message. It may already be part of the reply.",
              retryable: false,
            }),
            "Removing the queued message failed",
          );
        }
      })
      .catch((error) => report(error, "Removing the queued message failed"));
  };
  const adapter = Object.defineProperties({} as ExternalThreadQueueAdapter, {
    items: { enumerable: true, get: () => getSnapshot().items },
    steerItems: { enumerable: true, get: () => getSnapshot().steerItems },
    enqueue: { enumerable: true, value: enqueue },
    steer: { enumerable: true, value: steer },
    move: { enumerable: true, value: move },
    edit: { enumerable: true, value: edit },
    remove: { enumerable: true, value: remove },
  });
  // R0 is listened to only while a listener is subscribed. A subscriber that goes away and comes
  // back (React StrictMode runs effect cleanups and setups again in development) reconnects here,
  // so the bar is never left attached to a port it has disposed.
  let disconnectPort: (() => void) | undefined;
  const connect = (): void => {
    disconnectPort ??= port.subscribe(() => {
      lastError = undefined;
      const snapshot = getSnapshot();
      for (const listener of [...listeners]) listener(snapshot);
    });
  };
  const disconnect = (): void => {
    disconnectPort?.();
    disconnectPort = undefined;
  };
  return {
    adapter,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },
    removeForEdit,
    dispose() {
      disconnect();
      listeners.clear();
    },
  };
}
