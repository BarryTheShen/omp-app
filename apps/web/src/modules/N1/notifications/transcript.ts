import type { Notification } from "../contract";

export interface TranscriptNoticesSnapshot {
  /** Oldest first. */
  readonly notices: readonly Notification[];
}

/**
 * The notices the projector draws in a chat's transcript, after its messages (a todo reminder, a failed
 * retry). A chat keeps only the newest notice of each kind, so a later reminder replaces an earlier one and
 * the list does not grow with every turn. The list lives as long as the projector that writes it.
 */
export class TranscriptNotices {
  private snapshot: TranscriptNoticesSnapshot = Object.freeze({ notices: Object.freeze([]) });
  private readonly listeners = new Set<() => void>();

  public readonly upsert = (notification: Notification): void => {
    const kind = notification.source ?? notification.dedupeKey;
    const kept = this.snapshot.notices.filter(
      (item) => item.threadId !== notification.threadId || (item.source ?? item.dedupeKey) !== kind,
    );
    this.snapshot = Object.freeze({ notices: Object.freeze([...kept, notification]) });
    for (const listener of this.listeners) listener();
  };

  public readonly getSnapshot = (): TranscriptNoticesSnapshot => this.snapshot;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
