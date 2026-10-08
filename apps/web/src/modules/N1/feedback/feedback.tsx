import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { InlineError } from "@/components/blocks";
import type { Notification } from "../contract";
import type {
  NotificationBusSnapshot,
  NotificationProjectionSnapshot,
  NotificationProjector,
} from "../notifications";

/** The newest toasts shown at once; the rest are counted, not drawn. */
export const MAX_VISIBLE_TOASTS = 3;
/** How long an info, success or warning toast stays before it leaves. Errors stay until dismissed. */
export const TOAST_LIFETIME_MS = 6000;

function useProjectionSnapshot(projector: NotificationProjector): NotificationProjectionSnapshot {
  const subscribe = useCallback(
    (listener: (snapshot: NotificationProjectionSnapshot) => void) => projector.subscribe(listener),
    [projector],
  );
  const getSnapshot = useCallback(() => projector.getSnapshot(), [projector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useNotificationSnapshot(projector: NotificationProjector): NotificationBusSnapshot {
  const bus = projector.getBus();
  const subscribe = useCallback(
    (listener: (snapshot: NotificationBusSnapshot) => void) => bus.subscribe(listener),
    [bus],
  );
  const getSnapshot = useCallback(() => bus.getSnapshot(), [bus]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function severityClass(notification: Notification): string {
  switch (notification.severity) {
    case "error":
      return "border-destructive/50 bg-destructive/10 text-destructive";
    case "warning":
      return "border-warning/50 bg-warning/10 text-foreground";
    default:
      return "border-border bg-muted text-foreground";
  }
}

function NotificationItem({
  notification,
  projector,
}: {
  readonly notification: Notification;
  readonly projector: NotificationProjector;
}) {
  // Stable across renders: the expiry timer below restarts whenever this identity changes.
  const onDismiss = useCallback(
    () => projector.getBus().dismiss(notification.threadId, notification.dedupeKey),
    [notification.dedupeKey, notification.threadId, projector],
  );
  const [paused, setPaused] = useState(false);
  const sticky = notification.severity === "error";

  // The timer restarts when the pointer or the keyboard focus leaves: a toast is never taken away
  // while someone is reading it.
  useEffect(() => {
    if (sticky || paused) return;
    const timer = window.setTimeout(onDismiss, TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss, paused, sticky]);

  return (
    <article
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${severityClass(notification)}`}
      data-notification-placement={notification.placement}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <p
        aria-live={notification.live === "off" ? undefined : notification.live}
        className="min-w-0 flex-1 whitespace-pre-wrap"
        role={notification.severity === "error" ? "alert" : "status"}
      >
        {notification.message}
      </p>
      <button
        aria-label="Dismiss notification"
        className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onDismiss}
        type="button"
      >
        ×
      </button>
    </article>
  );
}

export function NotificationFeedback({ projector }: { readonly projector: NotificationProjector }) {
  const projection = useProjectionSnapshot(projector);
  const notifications = useNotificationSnapshot(projector);

  useEffect(() => {
    const timer = window.setInterval(() => {
      projector.getBus().expire();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [projector]);

  const visibleNotifications = notifications.notifications.filter(
    (notification) => notification.placement === "toast" || notification.placement === "banner",
  );
  const shown = visibleNotifications.slice(-MAX_VISIBLE_TOASTS);
  const hiddenCount = visibleNotifications.length - shown.length;
  const hasContent =
    projection.error !== null ||
    projection.statuses.length > 0 ||
    projection.widgets.length > 0 ||
    visibleNotifications.length > 0;
  if (!hasContent) return null;

  return (
    <section
      aria-label="Notifications"
      className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-1.5"
      data-n1-feedback="true"
      data-testid="n1-feedback"
    >
      {projection.error ? (
        <InlineError
          heading="omp update unavailable"
          message={projection.error.message}
          variant="compact"
        />
      ) : null}
      {projection.statuses.map((status) => (
        <div
          className="text-muted-foreground min-w-0 truncate text-xs"
          data-status-key={status.statusKey}
          key={status.statusKey}
          role="status"
        >
          {status.statusText}
        </div>
      ))}
      {projection.widgets.map((widget) => (
        <section
          aria-label={`Extension widget: ${widget.widgetKey}`}
          className="border-border bg-muted rounded-md border px-3 py-2 text-xs"
          data-widget-key={widget.widgetKey}
          key={widget.widgetKey}
        >
          {widget.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </section>
      ))}
      {shown.map((notification) => (
        <NotificationItem
          key={`${notification.threadId}:${notification.dedupeKey}`}
          notification={notification}
          projector={projector}
        />
      ))}
      {hiddenCount > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="n1-feedback-more">
          +{hiddenCount} more
        </p>
      )}
    </section>
  );
}
