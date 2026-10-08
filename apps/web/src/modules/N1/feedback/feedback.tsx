import type { NotificationProjector } from "../notifications";
import { LiveAnnouncer } from "./announcer";
import { useNotificationSnapshot, useProjectionSnapshot } from "./hooks";
import { NotificationBanners, NotificationToasts } from "./notices";
import { ExtensionWidgets, ProjectionStatus, type WidgetPlacement } from "./status";

/** Which extension widgets a strip draws: one placement, both, or none. */
export type WidgetScope = WidgetPlacement | "all" | "none";

export interface NotificationFeedbackProps {
  readonly projector: NotificationProjector;
  /** The widgets this strip draws. The default draws both placements, as the status bar always has. */
  readonly widgets?: WidgetScope;
}

/**
 * Everything the page says without asking for attention, in one strip: the projection's error and
 * statuses, the anchored banners, the extension widgets and the toasts. Each part is also exported on
 * its own, so the layout can place a widget above the composer and the toasts elsewhere. The live
 * region is always mounted, so a notice that arrives later is read as it lands, and the strip hides
 * itself rather than unmounting, so focus is never lost to a removed element.
 */
export function NotificationFeedback({ projector, widgets = "all" }: NotificationFeedbackProps) {
  const projection = useProjectionSnapshot(projector);
  const notifications = useNotificationSnapshot(projector);
  const hasContent =
    projection.error !== null ||
    projection.statuses.length > 0 ||
    projection.widgets.some((widget) => widgets === "all" || widgets === widget.placement) ||
    notifications.notifications.some(
      (notification) => notification.placement === "banner" || notification.placement === "toast",
    );

  return (
    <>
      <LiveAnnouncer projector={projector} />
      <section
        aria-label="Notices"
        className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-1.5"
        data-n1-feedback="true"
        data-testid="n1-feedback"
        hidden={!hasContent}
      >
        <ProjectionStatus projector={projector} />
        <NotificationBanners projector={projector} />
        {widgets === "all" || widgets === "aboveEditor" ? (
          <ExtensionWidgets placement="aboveEditor" projector={projector} />
        ) : null}
        {widgets === "all" || widgets === "belowEditor" ? (
          <ExtensionWidgets placement="belowEditor" projector={projector} />
        ) : null}
        <NotificationToasts projector={projector} />
      </section>
    </>
  );
}
