import type { AppError, StreamKey } from "@omp-app/contracts";
import { EventFrame as EventFrameSchema, StreamKey as StreamKeySchema } from "@omp-app/contracts";
import type { z } from "zod";

export type ReplayEventFrame = z.output<typeof EventFrameSchema>;

export interface ReplayConflict {
  readonly error: AppError;
}

export interface ReplayResult {
  readonly frames: readonly ReplayEventFrame[];
}

interface StreamState {
  nextSeq: number;
  frames: ReplayEventFrame[];
}

type Subscriber = (frame: ReplayEventFrame) => void;

/** Per-stream sequence assignment and bounded replay for reconnecting clients. */
export class EventReplayHub {
  readonly #limit: number;
  readonly #streams = new Map<StreamKey, StreamState>();
  readonly #subscribers = new Map<StreamKey, Set<Subscriber>>();

  constructor(limit = 256) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Replay limit must be a positive integer");
    }
    this.#limit = limit;
  }

  publish(stream: StreamKey, payload: unknown): ReplayEventFrame {
    const validStream = StreamKeySchema.parse(stream);
    const state = this.#streams.get(validStream) ?? { nextSeq: 0, frames: [] };
    const frame = EventFrameSchema.parse({
      type: "event",
      stream: validStream,
      seq: state.nextSeq + 1,
      payload,
    });
    state.nextSeq = frame.seq;
    state.frames.push(frame);
    if (state.frames.length > this.#limit) state.frames.shift();
    this.#streams.set(validStream, state);

    for (const subscriber of this.#subscribers.get(validStream) ?? []) subscriber(frame);
    return frame;
  }

  replay(stream: StreamKey, afterSeq: number | undefined): ReplayResult | ReplayConflict {
    const validStream = StreamKeySchema.parse(stream);
    const state = this.#streams.get(validStream) ?? { nextSeq: 0, frames: [] };
    if (afterSeq === undefined) return { frames: [] };
    const oldestSeq = state.frames[0]?.seq ?? state.nextSeq + 1;
    if (afterSeq > state.nextSeq || afterSeq < oldestSeq - 1) {
      return {
        error: {
          code: "conflict",
          message: "The requested event history is no longer available",
          retryable: true,
        },
      };
    }
    return { frames: state.frames.filter((frame) => frame.seq > afterSeq) };
  }

  subscribe(stream: StreamKey, subscriber: Subscriber): () => void {
    const validStream = StreamKeySchema.parse(stream);
    const subscribers = this.#subscribers.get(validStream) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(validStream, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(validStream);
    };
  }

  latestSeq(stream: StreamKey): number {
    return this.#streams.get(StreamKeySchema.parse(stream))?.nextSeq ?? 0;
  }
}
