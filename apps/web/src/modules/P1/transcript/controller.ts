import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AppFailure } from "@omp-app/contracts";
import type { AgentRef, AgentStatus, FocusedTranscriptEvent } from "@/modules/P1/contract";
import { asAppFailure } from "./failures";
import type { TranscriptFeed } from "./source";
import {
  applyTranscriptPage,
  EMPTY_TRANSCRIPT_TAIL,
  requestOffset,
  type TranscriptTailState,
} from "./tail";

/** What the transcript view shows. A new object is made only when something it shows has changed. */
export interface TranscriptView {
  readonly messages: readonly ThreadMessageLike[];
  /** Nothing has been read yet, and nothing has failed. */
  readonly loading: boolean;
  /** The last read failed; `messages` is what had been read before it. */
  readonly failure: AppFailure | undefined;
  /** The live feed could not start, or was lost. The transcript still refreshes on a timer. */
  readonly liveFailure: AppFailure | undefined;
  readonly agentStatus: AgentStatus;
  /** Asks for a read now; the view's "Try again" action. */
  readonly refresh: () => void;
}

export interface TranscriptTailOptions {
  readonly feed: TranscriptFeed;
  /** Milliseconds between reads while the worker runs, even when no live frame arrives. */
  readonly heartbeatMs?: number;
  /** The shortest gap between two reads; frames that arrive inside it are merged into one read. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_MIN_INTERVAL_MS = 300;

/** A worker that may still write to its transcript. */
function isLive(agent: AgentRef): boolean {
  return agent.status === "running" || agent.status === "pending";
}

function sameWorker(left: AgentRef, right: AgentRef): boolean {
  return left.threadId === right.threadId && left.id === right.id;
}

/**
 * Tails one worker's transcript by byte cursor. Live frames, a timer while the worker runs and one
 * read after it ends all ask for the same thing: the records after the cursor. Reads never overlap,
 * frames that arrive together become one read, and a read that finishes after `stop()` is ignored.
 * A finished worker is read once and then left alone; its file stays readable.
 */
export class TranscriptTail {
  private feed: TranscriptFeed;
  private state: TranscriptTailState = EMPTY_TRANSCRIPT_TAIL;
  private failure: AppFailure | undefined;
  private liveFailure: AppFailure | undefined;
  private view: TranscriptView;
  private readonly listeners = new Set<() => void>();
  private readonly heartbeatMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private started = false;
  /** Bumped whenever work is cancelled, so a read that finishes afterwards does not touch the state. */
  private generation = 0;
  private reading = false;
  private wanted = false;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private scheduled: number | undefined;
  private heartbeat: number | undefined;
  private unsubscribeLive: (() => void) | undefined;

  constructor(options: TranscriptTailOptions) {
    this.feed = options.feed;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.view = this.buildView();
  }

  /** For useSyncExternalStore. The identity is fixed, so a subscriber is never re-attached. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** For useSyncExternalStore. The view changes only through `publish`, so this is cheap. */
  readonly getView = (): TranscriptView => this.view;

  readonly refresh = (): void => {
    this.request(true);
  };

  /** Starts the live work and the first read. Calling it again while started does nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachLive();
    this.request(true);
    this.armHeartbeat();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.cancelWork();
  }

  /**
   * Takes the latest reference for this worker. A worker that stops gets one last read. Another
   * worker starts the tail over: the old worker's text and cursor are dropped.
   */
  setFeed(feed: TranscriptFeed): void {
    if (!sameWorker(feed.agent, this.feed.agent)) {
      this.switchWorker(feed);
      return;
    }
    const wasLive = isLive(this.feed.agent);
    this.feed = feed;
    const nowLive = isLive(feed.agent);
    if (feed.agent.status !== this.view.agentStatus) this.publish();
    if (!this.started) return;
    if (wasLive && !nowLive) {
      this.detachLive();
      window.clearTimeout(this.heartbeat);
      this.heartbeat = undefined;
      this.request(true);
    }
    if (!wasLive && nowLive) {
      this.attachLive();
      this.armHeartbeat();
    }
  }

  private switchWorker(feed: TranscriptFeed): void {
    this.cancelWork();
    this.feed = feed;
    this.state = EMPTY_TRANSCRIPT_TAIL;
    this.failure = undefined;
    this.liveFailure = undefined;
    this.lastReadAt = Number.NEGATIVE_INFINITY;
    this.publish();
    if (!this.started) return;
    this.attachLive();
    this.request(true);
    this.armHeartbeat();
  }

  /** Drops every pending read, timer and live subscription; reads that are still in flight are ignored. */
  private cancelWork(): void {
    this.generation += 1;
    this.reading = false;
    this.wanted = false;
    window.clearTimeout(this.scheduled);
    window.clearTimeout(this.heartbeat);
    this.scheduled = undefined;
    this.heartbeat = undefined;
    this.detachLive();
  }

  private request(urgent: boolean): void {
    if (!this.started) return;
    this.wanted = true;
    if (this.reading || this.scheduled !== undefined) return;
    const wait = urgent ? 0 : Math.max(0, this.lastReadAt + this.minIntervalMs - this.now());
    if (wait === 0) {
      void this.read();
      return;
    }
    this.scheduled = window.setTimeout(() => {
      this.scheduled = undefined;
      void this.read();
    }, wait);
  }

  private async read(): Promise<void> {
    if (!this.started || this.reading || !this.wanted) return;
    this.wanted = false;
    this.reading = true;
    const generation = this.generation;
    const feed = this.feed;
    const requestedFrom = requestOffset(this.state, feed.agent.sessionFile);
    this.lastReadAt = this.now();
    try {
      const page = await feed.read({ fromByte: requestedFrom });
      if (generation !== this.generation) return;
      const next = applyTranscriptPage(this.state, page, requestedFrom);
      const recovered = this.failure !== undefined;
      this.failure = undefined;
      if (next !== this.state || recovered) {
        this.state = next;
        this.publish();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.failure = asAppFailure(error);
      this.publish();
    } finally {
      if (generation === this.generation) {
        this.reading = false;
        if (this.wanted) this.request(false);
      }
    }
  }

  private armHeartbeat(): void {
    window.clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    if (!this.started || !isLive(this.feed.agent)) return;
    const generation = this.generation;
    this.heartbeat = window.setTimeout(() => {
      this.heartbeat = undefined;
      if (generation !== this.generation) return;
      this.request(false);
      this.armHeartbeat();
    }, this.heartbeatMs);
  }

  private attachLive(): void {
    if (this.unsubscribeLive !== undefined || !isLive(this.feed.agent)) return;
    try {
      this.unsubscribeLive = this.feed.subscribe(
        (event) => this.onLiveFrame(event),
        (failure) => this.setLiveFailure(failure),
      );
      this.setLiveFailure(undefined);
    } catch (error) {
      this.setLiveFailure(asAppFailure(error));
    }
  }

  private detachLive(): void {
    const unsubscribe = this.unsubscribeLive;
    this.unsubscribeLive = undefined;
    unsubscribe?.();
  }

  /** A frame for this worker means its transcript may have grown; a lifecycle frame means it ended. */
  private onLiveFrame(event: FocusedTranscriptEvent): void {
    this.request(event.event.type === "subagent_lifecycle");
  }

  private setLiveFailure(failure: AppFailure | undefined): void {
    if (this.liveFailure === failure) return;
    this.liveFailure = failure;
    this.publish();
  }

  private buildView(): TranscriptView {
    return Object.freeze({
      messages: this.state.messages,
      loading: this.state.revision === 0 && this.failure === undefined,
      failure: this.failure,
      liveFailure: this.liveFailure,
      agentStatus: this.feed.agent.status,
      refresh: this.refresh,
    });
  }

  private publish(): void {
    this.view = this.buildView();
    for (const listener of this.listeners) listener();
  }
}
