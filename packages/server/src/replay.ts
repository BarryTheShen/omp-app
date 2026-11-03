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

export type StreamActivityListener = (stream: StreamKey, active: boolean) => void;

interface StreamState {
  nextSeq: number;
  frames: ReplayEventFrame[];
}

type Subscriber = (frame: ReplayEventFrame) => void;

/** Per-stream sequence assignment, bounded replay, and subscriber activity notifications. */
export class EventReplayHub {
  readonly #limit: number;
  readonly #streams = new Map<StreamKey, StreamState>();
  readonly #subscribers = new Map<StreamKey, Set<Subscriber>>();
  readonly #activityWatchers = new Map<string, Set<StreamActivityListener>>();

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

  /**
   * Delivers an event to the stream's subscribers now and keeps no copy: for live pictures (the app's browser's frames),
   * where a missed one is worth nothing and keeping them would hold megabytes. A resume from before it gets a conflict.
   */
  publishLive(stream: StreamKey, payload: unknown): void {
    const validStream = StreamKeySchema.parse(stream);
    const state = this.#streams.get(validStream) ?? { nextSeq: 0, frames: [] };
    const frame = EventFrameSchema.parse({
      type: "event",
      stream: validStream,
      seq: state.nextSeq + 1,
      payload,
    });
    state.nextSeq = frame.seq;
    state.frames.length = 0;
    this.#streams.set(validStream, state);
    for (const subscriber of this.#subscribers.get(validStream) ?? []) subscriber(frame);
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

  /** Register a callback for first/last activity of every stream beginning with `prefix`. */
  registerStreamActivity(prefix: string, listener: StreamActivityListener): () => void {
    if (prefix.length === 0) throw new Error("Stream activity prefix must not be empty");
    const listeners = this.#activityWatchers.get(prefix) ?? new Set<StreamActivityListener>();
    listeners.add(listener);
    this.#activityWatchers.set(prefix, listeners);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      listeners.delete(listener);
      if (listeners.size === 0) this.#activityWatchers.delete(prefix);
    };
  }

  subscribe(stream: StreamKey, subscriber: Subscriber): () => void {
    const validStream = StreamKeySchema.parse(stream);
    const subscribers = this.#subscribers.get(validStream) ?? new Set<Subscriber>();
    const first = subscribers.size === 0;
    subscribers.add(subscriber);
    this.#subscribers.set(validStream, subscribers);
    if (first) {
      try {
        this.#notifyActivity(validStream, true);
      } catch (error) {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) this.#subscribers.delete(validStream);
        throw error;
      }
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      subscribers.delete(subscriber);
      if (subscribers.size !== 0) return;
      this.#subscribers.delete(validStream);
      this.#notifyActivity(validStream, false);
    };
  }

  latestSeq(stream: StreamKey): number {
    return this.#streams.get(StreamKeySchema.parse(stream))?.nextSeq ?? 0;
  }

  /**
   * Carries a stream's history and sequence over to another key, for a process that moved to a new
   * thread id, so its events keep their numbering on the same run. The old key is left empty, and each
   * carried frame names its new stream.
   */
  moveStream(from: StreamKey, to: StreamKey): void {
    const source = StreamKeySchema.parse(from);
    const target = StreamKeySchema.parse(to);
    const state = this.#streams.get(source);
    if (source === target || state === undefined) return;
    this.#streams.delete(source);
    this.#streams.set(target, {
      nextSeq: state.nextSeq,
      frames: state.frames.map((frame) => ({ ...frame, stream: target })),
    });
  }

  #notifyActivity(stream: StreamKey, active: boolean): void {
    for (const [prefix, listeners] of this.#activityWatchers) {
      if (!stream.startsWith(prefix)) continue;
      for (const listener of [...listeners]) listener(stream, active);
    }
  }
}
