import { InlineError } from "@/components/blocks";
import type { NotificationProjector } from "../notifications";
import { useProjectionSnapshot } from "./hooks";

/** Where an extension widget sits: above the composer, or below it. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/**
 * The projection's error and the extension statuses. Statuses are ambient text that changes often, so
 * they are not read aloud; the error is read by its own alert.
 */
export function ProjectionStatus({ projector }: { readonly projector: NotificationProjector }) {
  const projection = useProjectionSnapshot(projector);
  return (
    <>
      {projection.error ? (
        <InlineError
          heading="omp update unavailable"
          message={projection.error.message}
          variant="compact"
        />
      ) : null}
      {projection.statuses.map((status) => (
        <p
          className="min-w-0 break-words text-xs text-muted-foreground"
          data-status-key={status.statusKey}
          key={status.statusKey}
        >
          {status.statusText}
        </p>
      ))}
    </>
  );
}

/** The extension widgets with one placement. Widgets take no focus and are not read aloud. */
export function ExtensionWidgets({
  projector,
  placement,
}: {
  readonly projector: NotificationProjector;
  readonly placement: WidgetPlacement;
}) {
  const projection = useProjectionSnapshot(projector);
  const widgets = projection.widgets.filter((widget) => widget.placement === placement);
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-widget-placement={placement}
      hidden={widgets.length === 0}
    >
      {widgets.map((widget) => (
        <section
          aria-label={`Extension widget: ${widget.widgetKey}`}
          className="min-w-0 break-words rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground"
          data-widget-key={widget.widgetKey}
          key={widget.widgetKey}
        >
          <p className="whitespace-pre-line break-words">{widget.lines.join("\n")}</p>
        </section>
      ))}
    </div>
  );
}
