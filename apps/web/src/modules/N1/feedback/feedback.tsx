import type { Notification } from "../contract";
import type { NotificationProjector } from "../notifications";
import { LiveAnnouncer } from "./announcer";
import { useChatNotifications, useProjectionSnapshot } from "./hooks";
import {
  isQuietNotice,
  isStackNotice,
  NotificationBanners,
  NotificationQuiet,
  NotificationToasts,
  usePanelLeaving,
} from "./notices";
import { ExtensionWidgets, ProjectionStatus, type WidgetPlacement } from "./status";

/** Which extension widgets a strip draws: one placement, both, or none. */
export type WidgetScope = WidgetPlacement | "all" | "none";

export interface NotificationFeedbackProps {
  readonly projector: NotificationProjector;
  /** The widgets this strip draws. The default draws both placements, as the status bar always has. */
  readonly widgets?: WidgetScope;
  /**
   * Whether the strip draws the banners and toasts too. The app draws them with `NotificationNotices` (in the chat's notices
   * row, or over an empty chat's footer), so it passes "none".
   */
  readonly notices?: "all" | "none";
}

/**
 * Everything the page says without asking for attention, in one strip: the projection's error and
 * statuses, the extension widgets, and by default the banners and toasts. Each part is also exported on
 * its own, so the layout can place a widget above the composer and the notices elsewhere. The live
 * region is always mounted, so a notice that arrives later is read as it lands, and the strip hides
 * itself rather than unmounting, so focus is never lost to a removed element.
 */
export function NotificationFeedback({
  projector,
  widgets = "all",
  notices = "all",
}: NotificationFeedbackProps) {
  const projection = useProjectionSnapshot(projector);
  const notifications = useChatNotifications(projector);
  const leaving = usePanelLeaving(notifications);
  const showsNotices = notices === "all";
  const hasContent =
    projection.error !== null ||
    projection.statuses.length > 0 ||
    projection.widgets.some((widget) => widgets === "all" || widgets === widget.placement) ||
    (showsNotices && (hasPanelNotice(notifications) || leaving));

  return (
    <>
      <LiveAnnouncer projector={projector} />
      <section
        aria-label="Status and widgets"
        className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-1.5"
        data-n1-feedback="true"
        data-testid="n1-feedback"
        hidden={!hasContent}
      >
        <ProjectionStatus projector={projector} />
        {showsNotices ? <NotificationBanners projector={projector} /> : null}
        {widgets === "all" || widgets === "aboveEditor" ? (
          <ExtensionWidgets placement="aboveEditor" projector={projector} />
        ) : null}
        {widgets === "all" || widgets === "belowEditor" ? (
          <ExtensionWidgets placement="belowEditor" projector={projector} />
        ) : null}
        {showsNotices ? <NotificationToasts projector={projector} /> : null}
        {showsNotices ? <NotificationQuiet projector={projector} /> : null}
      </section>
    </>
  );
}

/**
 * The banners and toasts as one solid panel. A chat with messages draws it in the notices row between the transcript and
 * the composer, where it takes its own room: the composer does not move, and nothing is drawn over a message. An empty chat
 * draws it over the footer (the layout's `threadOverlay` area), where it floats above the footer's controls. The live
 * region is the one the status strip mounts, which stays mounted in the status bar, so the panel needs no announcer of its
 * own.
 */
export function NotificationNotices({ projector }: { readonly projector: NotificationProjector }) {
  const notifications = useChatNotifications(projector);
  const leaving = usePanelLeaving(notifications);
  return (
    <section
      aria-label="Notices"
      className="pointer-events-auto mb-2 flex min-w-0 flex-col gap-1 bg-background"
      data-testid="n1-notices"
      hidden={!(hasPanelNotice(notifications) || leaving)}
    >
      <NotificationBanners projector={projector} />
      <NotificationToasts projector={projector} />
      <NotificationQuiet projector={projector} />
    </section>
  );
}

/** Whether the notices panel has anything to draw: a banner or toast, or the omp notices line. */
function hasPanelNotice(notifications: readonly Notification[]): boolean {
  return notifications.some(
    (notification) => isStackNotice(notification) || isQuietNotice(notification),
  );
}
