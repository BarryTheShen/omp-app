import type { ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { Notification } from "../contract";
import { Notification as NotificationSchema } from "../contract";
import type { RetiredNotices } from "./retired";

export interface NotificationBusSnapshot {
  readonly revision: number;
  readonly notifications: readonly Notification[];
}

export type NotificationBusListener = (snapshot: NotificationBusSnapshot) => void;
export type NotificationPublishResult = "published" | "replaced" | "deduplicated";

const EMPTY_NOTIFICATIONS: readonly Notification[] = Object.freeze([]);
export const MAX_NOTIFICATIONS_PER_THREAD = 256;

/**
 * The stable key used by the feedback chrome. A thread id and a producer-owned dedupe key are
 * kept as separate fields on the public API; the separator is only an internal Map key.
 */
export function notificationKey(threadId: ThreadId, dedupeKey: string): string {
  return `${JSON.stringify(String(threadId))}:${JSON.stringify(dedupeKey)}`;
}

/**
 * Whether a key names a stream notice: `<kind>:<sequence>:<fingerprint>`, where the sequence is the stream event that
 * produced it. Such a key comes back only from a replay of that event, so a dismissal of it can be remembered. A key
 * without a sequence is reused for the same text, so it is not.
 */
export function isStreamNoticeKey(dedupeKey: string): boolean {
  return /^(extension:notify|session:notice):\d+:/.test(dedupeKey);
}

function invalidNotification(): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message: "The notification payload is malformed.",
    retryable: false,
  });
}

function freezeNotification(value: Notification): Notification {
  const frozen: Notification = {
    threadId: value.threadId,
    dedupeKey: value.dedupeKey,
    severity: value.severity,
    placement: value.placement,
    message: value.message,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    live: value.live,
    focus: "preserve",
  };
  return Object.freeze(frozen);
}

function sameNotification(left: Notification, right: Notification): boolean {
  return (
    left.threadId === right.threadId &&
    left.dedupeKey === right.dedupeKey &&
    left.severity === right.severity &&
    left.placement === right.placement &&
    left.message === right.message &&
    left.source === right.source &&
    left.expiresAt === right.expiresAt &&
    left.live === right.live &&
    left.focus === right.focus
  );
}

function freezeSnapshot(
  revision: number,
  notifications: readonly Notification[],
): NotificationBusSnapshot {
  return Object.freeze({
    revision,
    notifications: Object.freeze([...notifications]),
  });
}

export interface NotificationBusOptions {
  /** The stream notices a person let go of: a publish of one is ignored, so a replay does not bring it back. */
  readonly retired?: RetiredNotices;
}

/**
 * Immutable, thread-aware notification storage. A publish with the same `(threadId, dedupeKey)`
 * replaces the prior notice; an identical publish is ignored so reconnects cannot announce twice.
 * A stream notice let go of (see `retire`, and expiry) is ignored when it is published again.
 * The bus owns no timers and never moves focus. Consumers decide how to render each placement.
 */
export class NotificationBus {
  private readonly notices = new Map<string, Notification>();
  private readonly listeners = new Set<NotificationBusListener>();
  private readonly retired: RetiredNotices | undefined;
  private snapshot: NotificationBusSnapshot = freezeSnapshot(0, EMPTY_NOTIFICATIONS);

  public constructor(options: NotificationBusOptions = {}) {
    this.retired = options.retired;
  }

  public getSnapshot(): NotificationBusSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: NotificationBusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public get(threadId: ThreadId, dedupeKey: string): Notification | undefined {
    return this.notices.get(notificationKey(threadId, dedupeKey));
  }

  public publish(notification: Notification): NotificationPublishResult {
    const parsed = NotificationSchema.safeParse(notification);
    if (!parsed.success) throw invalidNotification();
    const frozen = freezeNotification(parsed.data);
    if (this.retired?.has(frozen.threadId, frozen.dedupeKey)) return "deduplicated";
    const key = notificationKey(frozen.threadId, frozen.dedupeKey);
    const previous = this.notices.get(key);
    if (previous && sameNotification(previous, frozen)) return "deduplicated";

    const result: NotificationPublishResult = previous ? "replaced" : "published";
    this.notices.set(key, frozen);
    // A quiet notice is remembered once it is shown: its stream replays it on every reopen and reload, and it is not
    // shown again.
    if (frozen.placement === "quiet" && isStreamNoticeKey(frozen.dedupeKey))
      this.retired?.remember(frozen.threadId, frozen.dedupeKey);
    this.trimThread(frozen.threadId);
    this.commit();
    return result;
  }

  public dismiss(threadId: ThreadId, dedupeKey: string): boolean {
    const removed = this.notices.delete(notificationKey(threadId, dedupeKey));
    if (removed) this.commit();
    return removed;
  }

  /**
   * The person, or the notice's own timer, let it go: it leaves the feedback and is not shown again when its stream is
   * replayed. A system removal (a resolved retry, a cleared projection error) is `dismiss`, which remembers nothing.
   */
  public retire(threadId: ThreadId, dedupeKey: string): boolean {
    if (isStreamNoticeKey(dedupeKey)) this.retired?.remember(threadId, dedupeKey);
    return this.dismiss(threadId, dedupeKey);
  }

  /**
   * Lets go of the quiet notices one omp source sent for a thread, once the request that caused them has its refusal
   * shown elsewhere. Each one is retired, so a replayed stream does not bring it back. Returns how many left.
   */
  public retireQuietFrom(threadId: ThreadId, source: string): number {
    const dedupeKeys = [...this.notices.values()]
      .filter(
        (notice) =>
          notice.threadId === threadId &&
          notice.placement === "quiet" &&
          notice.severity === "info" &&
          notice.source === source,
      )
      .map((notice) => notice.dedupeKey);
    let retired = 0;
    for (const dedupeKey of dedupeKeys) {
      if (this.retire(threadId, dedupeKey)) retired += 1;
    }
    return retired;
  }

  public clearForThread(threadId: ThreadId): number {
    const prefix = `${JSON.stringify(String(threadId))}:`;
    let removed = 0;
    for (const key of this.notices.keys()) {
      if (key.startsWith(prefix) && this.notices.delete(key)) removed += 1;
    }
    if (removed > 0) this.commit();
    return removed;
  }

  /** Remove expired entries when a host chooses to run its clock tick. */
  public expire(now = Date.now()): number {
    let removed = 0;
    for (const [key, notice] of this.notices) {
      if (notice.expiresAt !== undefined && notice.expiresAt <= now && this.notices.delete(key)) {
        removed += 1;
        if (isStreamNoticeKey(notice.dedupeKey))
          this.retired?.remember(notice.threadId, notice.dedupeKey);
      }
    }
    if (removed > 0) this.commit();
    return removed;
  }

  private trimThread(threadId: ThreadId): void {
    let count = 0;
    for (const notice of this.notices.values()) {
      if (notice.threadId === threadId) count += 1;
    }
    if (count <= MAX_NOTIFICATIONS_PER_THREAD) return;
    for (const [key, notice] of this.notices) {
      if (notice.threadId !== threadId) continue;
      this.notices.delete(key);
      count -= 1;
      if (count <= MAX_NOTIFICATIONS_PER_THREAD) return;
    }
  }

  private commit(): void {
    this.snapshot = freezeSnapshot(this.snapshot.revision + 1, [...this.notices.values()]);
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
