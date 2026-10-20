import type { Notification } from "../contract";

/** One entry of a notices stack: the notices with the same placement, severity and text, drawn as one line with a count. */
export interface NoticeEntry {
  /** Stable while the text repeats: the placement, the severity and the text. Focus and motion follow it. */
  readonly key: string;
  /** The newest notice of the entry: the text and the lifetime come from it. */
  readonly latest: Notification;
  /** Every notice of the entry, oldest first. Dismissing the entry dismisses each of them. */
  readonly members: readonly Notification[];
}

/** The key that makes two notices one entry: the same placement, severity and text. */
export function entryKeyOf(notification: Notification): string {
  return JSON.stringify([notification.placement, notification.severity, notification.message]);
}

/**
 * The notices, drawn as entries in the order their text first appeared. A notice whose text is already drawn joins that
 * entry rather than becoming a second copy, so a repeated notice is one entry with a count (issue 2181).
 */
export function noticeEntries(notifications: readonly Notification[]): NoticeEntry[] {
  const groups = new Map<string, Notification[]>();
  for (const notification of notifications) {
    const key = entryKeyOf(notification);
    const members = groups.get(key);
    if (members) members.push(notification);
    else groups.set(key, [notification]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    latest: members[members.length - 1] as Notification,
    members,
  }));
}
