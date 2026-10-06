import type { ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { Notification } from "../contract";
import { Notification as NotificationSchema } from "../contract";

export interface NotificationBusSnapshot {
  readonly revision: number;
  readonly notifications: readonly Notification[];
}

export type NotificationBusListener = (snapshot: NotificationBusSnapshot) => void;
export type NotificationPublishResult = "published" | "replaced" | "deduplicated";

const EMPTY_NOTIFICATIONS: readonly Notification[] = Object.freeze([]);

/**
 * The stable key used by the feedback chrome. A thread id and a producer-owned dedupe key are
 * kept as separate fields on the public API; the separator is only an internal Map key.
 */
export function notificationKey(threadId: ThreadId, dedupeKey: string): string {
  return `${JSON.stringify(String(threadId))}:${JSON.stringify(dedupeKey)}`;
}

function invalidNotification(): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message: "The notification payload is malformed.",
    retryable: false,
  });
}

function freezeNotification(value: Notification): Notification {
  return Object.freeze({
    threadId: value.threadId,
    dedupeKey: value.dedupeKey,
    severity: value.severity,
    placement: value.placement,
    message: value.message,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    live: value.live,
    focus: "preserve" as const,
  }) as Notification;
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

/**
 * Immutable, thread-aware notification storage. A publish with the same `(threadId, dedupeKey)`
 * replaces the prior notice; an identical publish is ignored so reconnects cannot announce twice.
 * The bus owns no timers and never moves focus. Consumers decide how to render each placement.
 */
export class NotificationBus {
  private readonly notices = new Map<string, Notification>();
  private readonly listeners = new Set<NotificationBusListener>();
  private snapshot: NotificationBusSnapshot = freezeSnapshot(0, EMPTY_NOTIFICATIONS);

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
    const key = notificationKey(frozen.threadId, frozen.dedupeKey);
    const previous = this.notices.get(key);
    if (previous && sameNotification(previous, frozen)) return "deduplicated";

    const result: NotificationPublishResult = previous ? "replaced" : "published";
    this.notices.set(key, frozen);
    this.commit();
    return result;
  }

  public dismiss(threadId: ThreadId, dedupeKey: string): boolean {
    const removed = this.notices.delete(notificationKey(threadId, dedupeKey));
    if (removed) this.commit();
    return removed;
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
      }
    }
    if (removed > 0) this.commit();
    return removed;
  }

  private commit(): void {
    this.snapshot = freezeSnapshot(this.snapshot.revision + 1, [...this.notices.values()]);
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
