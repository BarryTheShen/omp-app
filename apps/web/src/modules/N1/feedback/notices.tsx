import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ENTER_FADE, LEAVE_FADE, LEAVE_MS, NOTICE_SETTLE_MS } from "@/lib/motion";
import { usePresentItems } from "@/lib/presence";
import { Icons } from "../../../tokens";
import type { Notification } from "../contract";
import {
  type NotificationProjector,
  notificationKey,
  PROJECTION_ERROR_KEY,
} from "../notifications";
import { sessionDrawnNotices } from "./drawn-notices";
import { useChatNotifications, useExpiry } from "./hooks";
import { type NoticeEntry, noticeEntries } from "./repeats";

/** The newest toasts shown at once; the rest are counted and can be opened. */
export const MAX_VISIBLE_TOASTS = 3;
/** The newest banners shown at once; the rest are counted and can be opened. */
export const MAX_VISIBLE_BANNERS = 3;
/** How long a success notice's toast stays unless someone hovers or focuses it. */
export const TOAST_LIFETIME_MS = 6000;
/** The longest notice shown whole; a longer one is cut here, and "Show all" reads the rest. */
export const NOTICE_CUT_CHARS = 240;

/** U0's tone classes for each severity: the same ones the tool cards and worker chips use. */
export const NOTICE_TONE: Readonly<Record<Notification["severity"], string>> = Object.freeze({
  info: "border-info/30 bg-info-surface text-info-surface-foreground",
  success: "border-success/30 bg-success-surface text-success-surface-foreground",
  warning: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
  error: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
});

const FOCUSABLE =
  "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The composer's message input, under the name every person hears for it. */
const COMPOSER_INPUT = '[aria-label="Message input"]';

/** The entry's key, as the presence list reads it: a stable callback, so the list keeps its identity. */
const entryKey = (entry: NoticeEntry): string => entry.key;

/** True when the element and each of its ancestors is drawn: none is `hidden` or `display: none`. */
function isShown(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || node.hasAttribute("inert") || getComputedStyle(node).display === "none") {
      return false;
    }
  }
  return true;
}

/**
 * Where focus goes when a notice that held it leaves and no other notice in its stack remains: the
 * composer's message input, where the person was typing.
 */
function composerFocus(): HTMLElement | null {
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_INPUT))) {
    if (isShown(candidate)) return candidate;
  }
  return null;
}

/**
 * The last shown focusable element before `element`, outside it. It is the fallback only when the page
 * has no composer input, so focus never drops to the body.
 */
function shownFocusableBefore(element: HTMLElement): HTMLElement | null {
  let previous: HTMLElement | null = null;
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (element.contains(candidate) || !isShown(candidate)) continue;
    if (candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      previous = candidate;
    }
  }
  return previous;
}

function entryElement(root: HTMLElement, key: string): HTMLElement | null {
  for (const item of Array.from(root.querySelectorAll<HTMLElement>("[data-notice-key]"))) {
    if (item.dataset.noticeKey === key) return item;
  }
  return null;
}

/** The entry after `key` in `shown`, or the one before it when `key` is the last. */
function neighbourKey(shown: readonly NoticeEntry[], key: string): string | undefined {
  const keys = shown.map((entry) => entry.key);
  const index = keys.indexOf(key);
  if (index < 0) return undefined;
  return keys[index + 1] ?? keys[index - 1];
}

interface FocusHandoff {
  /** The entry to focus next, when one remains in the same stack. */
  readonly nextKey: string | undefined;
  /** Where focus goes when no entry in the stack remains. */
  readonly fallback: HTMLElement | null;
}

/**
 * A notice's words. A long one (an extension's list of tools can run to a screen of names) is cut at `NOTICE_CUT_CHARS`,
 * and "Show all" reads the rest; "Show less" cuts it again.
 */
function NoticeText({ text }: { readonly text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= NOTICE_CUT_CHARS) return <>{text}</>;
  return (
    <>
      {all ? text : `${text.slice(0, NOTICE_CUT_CHARS).trimEnd()}…`}{" "}
      <Button
        className="motion-reduce:transition-none"
        onClick={() => setAll((open) => !open)}
        size="xs"
        type="button"
        variant="ghost"
      >
        {all ? "Show less" : "Show all"}
      </Button>
    </>
  );
}

/** How many notices an entry holds, when the text came more than once: the count, read as a repeat. */
function RepeatCount({ count }: { readonly count: number }) {
  if (count < 2) return null;
  return (
    <span
      className="ml-1 whitespace-nowrap text-xs text-muted-foreground"
      data-notice-repeats={count}
    >
      <span aria-hidden="true">×{count}</span>
      <span className="sr-only"> repeated {count} times</span>
    </span>
  );
}

/**
 * Dismisses a notice after its lifetime, unless someone is reading it (`paused`). It is keyed by the notice drawn, so a repeat
 * of the text starts a new lifetime: a notice is never taken away while it is read, and a repeat gets its full time.
 */
function NoticeLifetime({
  paused,
  onExpire,
}: {
  readonly paused: boolean;
  readonly onExpire: () => void;
}) {
  const expireRef = useRef(onExpire);
  useEffect(() => {
    expireRef.current = onExpire;
  });
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => expireRef.current(), TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [paused]);
  return null;
}

interface NoticeItemProps {
  readonly entry: NoticeEntry;
  readonly expires: boolean;
  /** Fading out: the notice stays drawn, but inert, until it is removed. */
  readonly leaving: boolean;
  /** It joined the stack after the stack first drew: it fades in. */
  readonly entering: boolean;
  readonly onDismiss: (fromKeyboard: boolean) => void;
}

function NoticeItem({ entry, expires, leaving, entering, onDismiss }: NoticeItemProps) {
  // A notice fades in the first time it is drawn in this tab. The decision is taken at mount, so a later render never cuts
  // the fade short; a notice that a remount draws again (the notices move with the chat's first message) does not fade twice.
  const [enters] = useState(entering);
  const { latest } = entry;
  // Hovering and focusing are separate reasons to wait: a notice leaves six seconds after the last of
  // them ends, so a pointer that moves away never takes a notice that still has keyboard focus.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // Warnings and errors stay until someone dismisses them, and so does everything in a stack that does not expire.
  const sticky = !expires || latest.severity === "warning" || latest.severity === "error";
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissRef.current(true);
  }

  return (
    <article
      aria-hidden={leaving || undefined}
      className={`flex min-w-0 items-start gap-2 rounded-surface border border-foreground/10 bg-muted/30 px-3 py-2 text-sm ${NOTICE_TONE[latest.severity]} ${leaving ? LEAVE_FADE : enters ? ENTER_FADE : ""}`}
      data-notice-key={entry.key}
      data-notification-placement={latest.placement}
      inert={leaving || undefined}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {sticky ? null : (
        <NoticeLifetime
          key={latest.dedupeKey}
          onExpire={() => dismissRef.current(false)}
          paused={paused}
        />
      )}
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        <NoticeText text={latest.message} />
        <RepeatCount count={entry.members.length} />
      </p>
      <Button
        aria-label="Dismiss notification"
        className="motion-reduce:transition-none"
        data-notice-dismiss
        onClick={(event) => onDismiss(event.detail === 0)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Icons.close aria-hidden="true" />
      </Button>
    </article>
  );
}

interface NoticeStackProps {
  readonly notifications: readonly Notification[];
  readonly projector: NotificationProjector;
  readonly label: string;
  readonly limit: number;
  readonly moreTestId: string;
  readonly expires: boolean;
}

/** The tab's drawn notices as this page loaded them: a notice drawn before a reload is drawn again without a fade. */
const pageDrawnNotices = sessionDrawnNotices();

/**
 * The newest `limit` entries of one placement, with the rest counted. A notice whose text is drawn already joins its
 * entry, which counts up. "+N more" opens them all in a scrollable list and "Show fewer" closes it; neither moves focus.
 * Escape or the dismiss control removes an entry (every notice in it), and focus moves to a neighbour. When the stack
 * empties the list closes, and focus that was inside the stack returns to the composer.
 * An entry that an earlier load of this tab drew is drawn again without a fade (see `drawn-notices.ts`).
 */
function NoticeStack({
  notifications,
  projector,
  label,
  limit,
  moreTestId,
  expires,
}: NoticeStackProps) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const handoff = useRef<FocusHandoff | null>(null);
  const focusInside = useRef(false);
  const entries = useMemo(() => noticeEntries(notifications), [notifications]);
  const present = usePresentItems(entries, entryKey, LEAVE_MS);
  // The entries this stack has drawn are remembered for a reload, and forgotten once they have left. The tab's record is the
  // one the page loaded with, so a stack that mounts again (the notices move when a chat gets its first message) draws what
  // it has not drawn itself.
  const drawnKeys = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const keys = new Set(present.map((entry) => entry.item.key));
    for (const key of keys) {
      if (!drawnKeys.current.has(key)) pageDrawnNotices.drew(key);
    }
    for (const key of drawnKeys.current) {
      if (!keys.has(key)) pageDrawnNotices.left(key);
    }
    drawnKeys.current = keys;
  }, [present]);
  const shown = expanded ? present : present.slice(-limit);
  // An entry that is leaving is neither counted, focused nor dismissed again.
  const liveShown = shown.filter((entry) => !entry.leaving).map((entry) => entry.item);
  const hidden = entries.length - liveShown.length;

  useEffect(() => {
    if (entries.length === 0) setExpanded(false);
  }, [entries.length]);

  useLayoutEffect(() => {
    if (entries.length > 0 || !focusInside.current) return;
    focusInside.current = false;
    // Focus that the person moved elsewhere stays where it is; focus still on a control of this stack, or
    // lost to the page, moves to the composer.
    const active = document.activeElement;
    const heldHere = active !== null && rootRef.current?.contains(active) === true;
    const lost = active === null || active === document.body || !active.isConnected;
    if (heldHere || lost) composerFocus()?.focus();
  }, [entries.length]);

  useLayoutEffect(() => {
    const pending = handoff.current;
    if (pending === null) return;
    handoff.current = null;
    const root = rootRef.current;
    const next =
      root === null || pending.nextKey === undefined ? null : entryElement(root, pending.nextKey);
    const target = next?.querySelector<HTMLElement>("[data-notice-dismiss]") ?? pending.fallback;
    target?.focus();
  });

  function dismiss(entry: NoticeEntry, fromKeyboard: boolean) {
    const root = rootRef.current;
    const item = root === null ? null : entryElement(root, entry.key);
    // Only a keyboard or assistive-technology dismissal moves focus on. After a pointer click the browser
    // puts focus where it likes, and a focused notice is held, so handing focus on would pin a neighbour.
    if (fromKeyboard && root?.contains(item) && item?.contains(document.activeElement)) {
      handoff.current = {
        nextKey: neighbourKey(liveShown, entry.key),
        fallback: composerFocus() ?? (root === null ? null : shownFocusableBefore(root)),
      };
    }
    for (const member of entry.members) {
      projector.getBus().retire(member.threadId, member.dedupeKey);
    }
  }

  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-1"
      hidden={present.length === 0}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          focusInside.current = false;
        }
      }}
      onFocus={() => {
        focusInside.current = true;
      }}
      ref={rootRef}
    >
      <div className="flex max-h-[30dvh] min-w-0 flex-col gap-1 overflow-y-auto">
        {shown.map((item) => (
          <NoticeItem
            entering={
              performance.now() >= NOTICE_SETTLE_MS &&
              !pageDrawnNotices.isRestored(item.item.key) &&
              !drawnKeys.current.has(item.item.key)
            }
            entry={item.item}
            expires={expires}
            key={item.item.key}
            leaving={item.leaving}
            onDismiss={(fromKeyboard) => dismiss(item.item, fromKeyboard)}
          />
        ))}
      </div>
      {entries.length > limit || expanded ? (
        <Button
          aria-expanded={expanded}
          className="self-start bg-background motion-reduce:transition-none"
          data-testid={moreTestId}
          onClick={() => setExpanded((open) => !open)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Whether the banners-and-toasts stack draws a notice: every toast, and every banner except the projection's
 * own error, which the status strip's inline alert draws instead. The stack and its "has anything to show"
 * check both use this, so an empty stack is never drawn.
 */
export function isStackNotice(notification: Notification): boolean {
  if (notification.placement === "toast") return true;
  return notification.placement === "banner" && notification.dedupeKey !== PROJECTION_ERROR_KEY;
}

/**
 * Whether a banner, toast or quiet line is still fading out. The notices panel and the status strip stay drawn for it,
 * then hide, so `hidden` does not cut its fade short (issues 1209 and 1736).
 */
export function usePanelLeaving(notifications: readonly Notification[]): boolean {
  const fading = useMemo(
    () =>
      notifications.filter(
        (notification) => isStackNotice(notification) || isQuietNotice(notification),
      ),
    [notifications],
  );
  return usePresentItems(fading, notificationKeyOf, LEAVE_MS).some((entry) => entry.leaving);
}

/** The notice's key in the bus, as the presence list reads it. */
const notificationKeyOf = (notification: Notification): string =>
  notificationKey(notification.threadId, notification.dedupeKey);

/** Whether a notice is informational: it is kept in the omp notices line rather than drawn as a card. */
export function isQuietNotice(notification: Notification): boolean {
  return notification.placement === "quiet";
}

/**
 * The toasts: notices that stay until someone dismisses them (warnings and errors), and the success notices that leave
 * by themselves after a few seconds, unless someone is reading them.
 */
export function NotificationToasts({ projector }: { readonly projector: NotificationProjector }) {
  const notifications = useChatNotifications(projector);
  const toasts = useMemo(
    () => notifications.filter((notification) => notification.placement === "toast"),
    [notifications],
  );
  useExpiry(projector);
  return (
    <NoticeStack
      expires
      label="Recent notices"
      limit={MAX_VISIBLE_TOASTS}
      moreTestId="n1-feedback-more"
      notifications={toasts}
      projector={projector}
    />
  );
}

/**
 * The anchored banners: notices that stay where they are until they are dismissed or resolved, such as
 * a retry in progress or an error that needs attention. They never expire.
 */
export function NotificationBanners({ projector }: { readonly projector: NotificationProjector }) {
  const notifications = useChatNotifications(projector);
  const banners = useMemo(
    () =>
      notifications.filter(
        (notification) => notification.placement === "banner" && isStackNotice(notification),
      ),
    [notifications],
  );
  return (
    <NoticeStack
      expires={false}
      label="Important notices"
      limit={MAX_VISIBLE_BANNERS}
      moreTestId="n1-feedback-banners-more"
      notifications={banners}
      projector={projector}
    />
  );
}

/**
 * The informational notices omp sends, collapsed into one quiet line: "3 notices from omp". Opening it lists them, each
 * cut where it is long, and a repeated one with its count. The line fades in when its first notice arrives and fades out
 * once they are all dismissed; its list opens and closes over the motion tokens. The line is never read aloud, and a
 * notice that was shown is not shown again when its chat is reopened or the page reloads (see `NotificationBus.publish`).
 * Dismissing the line dismisses them all.
 */
export function NotificationQuiet({ projector }: { readonly projector: NotificationProjector }) {
  const notifications = useChatNotifications(projector);
  const listId = useId();
  const [open, setOpen] = useState(false);
  // A dismissed notice stays drawn for its fade (`LEAVE_MS`), so the line fades out with it instead of vanishing.
  const quiet = useMemo(() => notifications.filter(isQuietNotice), [notifications]);
  const entries = useMemo(() => noticeEntries(quiet), [quiet]);
  const present = usePresentItems(entries, entryKey, LEAVE_MS);
  const live = present.filter((entry) => !entry.leaving).map((entry) => entry.item);
  const count = live.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);
  return (
    <section
      aria-label="Notices from omp"
      className={`flex min-w-0 flex-col text-xs text-muted-foreground ${count === 0 ? LEAVE_FADE : ENTER_FADE}`}
      data-testid="n1-quiet"
      hidden={present.length === 0}
      inert={count === 0 || undefined}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Button
          aria-controls={listId}
          aria-expanded={open}
          className="motion-reduce:transition-none"
          data-testid="n1-quiet-toggle"
          onClick={() => setOpen((shown) => !shown)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {`${count} ${count === 1 ? "notice" : "notices"} from omp`}
        </Button>
        <Button
          aria-label="Dismiss notices from omp"
          className="motion-reduce:transition-none"
          onClick={() => {
            for (const entry of live) {
              for (const member of entry.members) {
                projector.getBus().dismiss(member.threadId, member.dedupeKey);
              }
            }
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Icons.close aria-hidden="true" />
        </Button>
      </div>
      <div
        className={`grid min-w-0 transition-[grid-template-rows,opacity,visibility] duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <ul
            className="flex max-h-[30dvh] min-w-0 flex-col gap-1 overflow-y-auto pt-1"
            id={listId}
            inert={!open || undefined}
          >
            {live.map((entry) => (
              <li
                className="min-w-0 break-words whitespace-pre-wrap"
                data-notice-key={entry.key}
                key={entry.key}
              >
                <NoticeText text={entry.latest.message} />
                <RepeatCount count={entry.members.length} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
