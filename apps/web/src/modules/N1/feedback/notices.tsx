import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icons } from "../../../tokens";
import type { Notification } from "../contract";
import {
  type NotificationProjector,
  notificationKey,
  PROJECTION_ERROR_KEY,
} from "../notifications";
import { useExpiry, useNotificationSnapshot } from "./hooks";

/** The newest toasts shown at once; the rest are counted and can be opened. */
export const MAX_VISIBLE_TOASTS = 3;
/** The newest banners shown at once; the rest are counted and can be opened. */
export const MAX_VISIBLE_BANNERS = 3;
/** How long an info, success or warning toast stays unless someone hovers or focuses it. */
export const TOAST_LIFETIME_MS = 6000;

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

/** True when the element and each of its ancestors is drawn: none is `hidden` or `display: none`. */
function isShown(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === "none") return false;
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

function keyOf(notification: Notification): string {
  return notificationKey(notification.threadId, notification.dedupeKey);
}

function noticeElement(root: HTMLElement, key: string): HTMLElement | null {
  for (const item of Array.from(root.querySelectorAll<HTMLElement>("[data-notice-key]"))) {
    if (item.dataset.noticeKey === key) return item;
  }
  return null;
}

/** The notice after `key` in `shown`, or the one before it when `key` is the last. */
function neighbourKey(shown: readonly Notification[], key: string): string | undefined {
  const keys = shown.map(keyOf);
  const index = keys.indexOf(key);
  if (index < 0) return undefined;
  return keys[index + 1] ?? keys[index - 1];
}

interface FocusHandoff {
  /** The notice to focus next, when one remains in the same stack. */
  readonly nextKey: string | undefined;
  /** Where focus goes when no notice in the stack remains. */
  readonly fallback: HTMLElement | null;
}

interface NoticeItemProps {
  readonly notification: Notification;
  readonly expires: boolean;
  readonly onDismiss: (fromKeyboard: boolean) => void;
}

function NoticeItem({ notification, expires, onDismiss }: NoticeItemProps) {
  // Hovering and focusing are separate reasons to wait: a notice leaves six seconds after the last of
  // them ends, so a pointer that moves away never takes a notice that still has keyboard focus.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // Errors stay until someone dismisses them, and so does everything in a stack that does not expire.
  const sticky = !expires || notification.severity === "error";
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  // The timer starts again when the last reason to wait ends, so a notice is never taken away while
  // someone is reading it.
  useEffect(() => {
    if (sticky || paused) return;
    const timer = window.setTimeout(() => dismissRef.current(false), TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [paused, sticky]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissRef.current(true);
  }

  return (
    <article
      className={`flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-xs ${NOTICE_TONE[notification.severity]}`}
      data-notice-key={keyOf(notification)}
      data-notification-placement={notification.placement}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{notification.message}</p>
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

/**
 * The newest `limit` notices of one placement, with the rest counted. "+N more" opens them all in a
 * scrollable list and "Show fewer" closes it; neither moves focus. Escape or the dismiss control removes
 * a notice, and focus moves to a neighbour. When the stack empties the list closes, and focus that was
 * inside the stack returns to the composer.
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
  const shown = expanded ? notifications : notifications.slice(-limit);
  const hidden = notifications.length - shown.length;

  useEffect(() => {
    if (notifications.length === 0) setExpanded(false);
  }, [notifications.length]);

  useLayoutEffect(() => {
    if (notifications.length > 0 || !focusInside.current) return;
    focusInside.current = false;
    // Focus that the person moved elsewhere stays where it is; focus still on a control of this stack, or
    // lost to the page, moves to the composer.
    const active = document.activeElement;
    const heldHere = active !== null && rootRef.current?.contains(active) === true;
    const lost = active === null || active === document.body || !active.isConnected;
    if (heldHere || lost) composerFocus()?.focus();
  }, [notifications.length]);

  useLayoutEffect(() => {
    const pending = handoff.current;
    if (pending === null) return;
    handoff.current = null;
    const root = rootRef.current;
    const next =
      root === null || pending.nextKey === undefined ? null : noticeElement(root, pending.nextKey);
    const target = next?.querySelector<HTMLElement>("[data-notice-dismiss]") ?? pending.fallback;
    target?.focus();
  });

  function dismiss(notification: Notification, fromKeyboard: boolean) {
    const key = keyOf(notification);
    const root = rootRef.current;
    const item = root === null ? null : noticeElement(root, key);
    // Only a keyboard or assistive-technology dismissal moves focus on. After a pointer click the browser
    // puts focus where it likes, and a focused notice is held, so handing focus on would pin a neighbour.
    if (fromKeyboard && root?.contains(item) && item?.contains(document.activeElement)) {
      handoff.current = {
        nextKey: neighbourKey(shown, key),
        fallback: composerFocus() ?? (root === null ? null : shownFocusableBefore(root)),
      };
    }
    projector.getBus().retire(notification.threadId, notification.dedupeKey);
  }

  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-1"
      hidden={notifications.length === 0}
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
        {shown.map((notification) => (
          <NoticeItem
            expires={expires}
            key={keyOf(notification)}
            notification={notification}
            onDismiss={(fromKeyboard) => dismiss(notification, fromKeyboard)}
          />
        ))}
      </div>
      {notifications.length > limit || expanded ? (
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
 * The toasts: transient notices that leave by themselves after a few seconds, unless someone is
 * reading them or they are errors.
 */
export function NotificationToasts({ projector }: { readonly projector: NotificationProjector }) {
  const snapshot = useNotificationSnapshot(projector);
  useExpiry(projector);
  return (
    <NoticeStack
      expires
      label="Recent notices"
      limit={MAX_VISIBLE_TOASTS}
      moreTestId="n1-feedback-more"
      notifications={snapshot.notifications.filter(
        (notification) => notification.placement === "toast",
      )}
      projector={projector}
    />
  );
}

/**
 * The anchored banners: notices that stay where they are until they are dismissed or resolved, such as
 * a retry in progress or an error that needs attention. They never expire.
 */
export function NotificationBanners({ projector }: { readonly projector: NotificationProjector }) {
  const snapshot = useNotificationSnapshot(projector);
  return (
    <NoticeStack
      expires={false}
      label="Important notices"
      limit={MAX_VISIBLE_BANNERS}
      moreTestId="n1-feedback-banners-more"
      notifications={snapshot.notifications.filter(
        (notification) => notification.placement === "banner" && isStackNotice(notification),
      )}
      projector={projector}
    />
  );
}
