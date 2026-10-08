import { useEffect, useRef, useState } from "react";
import type { Notification } from "../contract";
import { type NotificationProjector, PROJECTION_ERROR_KEY } from "../notifications";

/*
 * N1's live-region pair for notices. U0 has its own pair for its own announcements; that pair is empty
 * today, so this one is the only pair that speaks notices. Keep the two apart: merging them would read
 * a notice twice. Both regions are non-atomic, so a screen reader reads each addition and nothing else.
 */

/** How many announcements each region keeps; older ones have already been read out. */
const KEPT_ANNOUNCEMENTS = 3;

/**
 * The placements the strip shows. A notice placed in the transcript is shown nowhere (the app gives the
 * projector no transcript sink), so it is not read either.
 */
const SHOWN_PLACEMENTS: ReadonlySet<Notification["placement"]> = new Set(["banner", "toast"]);

export interface AnnouncementPass {
  /** Every announceable notice still on the bus, by key. The next pass compares against it. */
  readonly present: ReadonlySet<string>;
  /** Messages to read politely, in the order they arrived. */
  readonly polite: readonly string[];
  /** Messages to read assertively (errors), in the order they arrived. */
  readonly assertive: readonly string[];
}

/** A notice's identity and wording: the same notice with new wording is a new transition. */
function announcementKey(notification: Notification): string {
  return `${notification.threadId}\u0000${notification.dedupeKey}\u0000${notification.message}`;
}

/**
 * One pass over the notices on the bus. A notice is announced when it first appears or its wording
 * changes. A notice already announced stays quiet, and a notice that left the bus is forgotten, so a
 * later notice with the same key is announced again. The projection's own error is read by its inline
 * alert, so it is not read here.
 */
export function announcementsPass(
  previous: ReadonlySet<string>,
  notifications: readonly Notification[],
): AnnouncementPass {
  const present = new Set<string>();
  const polite: string[] = [];
  const assertive: string[] = [];
  for (const notification of notifications) {
    if (notification.live === "off" || !SHOWN_PLACEMENTS.has(notification.placement)) continue;
    if (notification.dedupeKey === PROJECTION_ERROR_KEY) continue;
    const key = announcementKey(notification);
    present.add(key);
    if (previous.has(key)) continue;
    if (notification.live === "assertive") assertive.push(notification.message);
    else polite.push(notification.message);
  }
  return { present, polite, assertive };
}

interface Announcement {
  readonly id: number;
  readonly text: string;
}

/**
 * The page's live-region policy for notices: a notice the strip shows is read once, politely, or
 * assertively for an error. Statuses and widgets are ambient text and are not read. The regions stay
 * mounted, so a notice that arrives later is read as it lands.
 */
export function LiveAnnouncer({ projector }: { readonly projector: NotificationProjector }) {
  const [polite, setPolite] = useState<readonly Announcement[]>([]);
  const [assertive, setAssertive] = useState<readonly Announcement[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const bus = projector.getBus();
    // Notices already on the bus when the regions mount were shown before anyone could hear them.
    let present = announcementsPass(new Set(), bus.getSnapshot().notifications).present;
    const numbered = (texts: readonly string[]): readonly Announcement[] =>
      texts.map((text) => {
        nextId.current += 1;
        return { id: nextId.current, text };
      });
    return bus.subscribe((snapshot) => {
      const pass = announcementsPass(present, snapshot.notifications);
      present = pass.present;
      if (pass.polite.length > 0) {
        const added = numbered(pass.polite);
        setPolite((current) => [...current, ...added].slice(-KEPT_ANNOUNCEMENTS));
      }
      if (pass.assertive.length > 0) {
        const added = numbered(pass.assertive);
        setAssertive((current) => [...current, ...added].slice(-KEPT_ANNOUNCEMENTS));
      }
    });
  }, [projector]);

  return (
    <>
      <div
        aria-atomic="false"
        aria-live="polite"
        className="sr-only"
        data-n1-live="polite"
        role="status"
      >
        {polite.map((item) => (
          <p key={item.id}>{item.text}</p>
        ))}
      </div>
      <div
        aria-atomic="false"
        aria-live="assertive"
        className="sr-only"
        data-n1-live="assertive"
        role="alert"
      >
        {assertive.map((item) => (
          <p key={item.id}>{item.text}</p>
        ))}
      </div>
    </>
  );
}
