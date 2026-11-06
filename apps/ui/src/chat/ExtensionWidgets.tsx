import type { ReactNode } from "react";
import type { ExtensionWidget } from "./store";

/** omp's terminal draws this many lines of a widget at most, then says it was cut (`MAX_WIDGET_LINES`). */
const MAX_LINES = 10;

/**
 * The lines omp's extensions show beside the message box (omp's `ctx.ui.setWidget`, #2842), above or below it as each
 * asked, in the order they were set; a widget set again moves to the end, as in omp's terminal. The lines are text, in
 * the terminal's monospace so an extension's columns line up.
 */
export function ExtensionWidgets({
  widgets,
  placement,
}: {
  readonly widgets: readonly ExtensionWidget[];
  readonly placement: ExtensionWidget["placement"];
}): ReactNode {
  const shown = widgets.filter((widget) => widget.placement === placement);
  if (shown.length === 0) return null;
  return (
    <section
      aria-label={
        placement === "aboveEditor"
          ? "From extensions, above the message box"
          : "From extensions, below the message box"
      }
      data-tour="extension-widgets"
      className={`flex flex-col gap-1 px-3 font-mono text-xs text-t2 ${placement === "aboveEditor" ? "pb-1.5" : "pt-1.5"}`}
    >
      {shown.map((widget) => (
        <div key={widget.key} data-widget={widget.key}>
          {widget.lines.slice(0, MAX_LINES).map((line, index) => (
            // A widget's lines are its own; their order is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines have no other key, and a line's place is its meaning
            <p key={index} className="min-h-[1lh] whitespace-pre-wrap break-words">
              {line}
            </p>
          ))}
          {widget.lines.length > MAX_LINES && <p className="text-t3">… (widget truncated)</p>}
        </div>
      ))}
    </section>
  );
}
