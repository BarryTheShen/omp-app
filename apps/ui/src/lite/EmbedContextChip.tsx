import { describeHostContext, type HostContext } from "@omp-app/contracts";
import { Eye, X } from "lucide-react";
import type { ReactNode } from "react";
import { embed, useEmbed } from "./embed";

/** The most of a selection the chip's tooltip shows. */
const TOOLTIP_SELECTION_MAX = 300;

/** The tooltip: where it is, and the selected words a message will carry, which the chip itself only counts. */
function tooltipOf(context: HostContext): string {
  const where = context.uri ?? context.title;
  const selected = context.selection?.trim() ?? "";
  if (selected === "") return where;
  const shown =
    selected.length > TOOLTIP_SELECTION_MAX
      ? `${selected.slice(0, TOOLTIP_SELECTION_MAX)}…`
      : selected;
  return `${where}\nSelected: ${shown}`;
}

/**
 * Above the lite view's message box: what is open in the app that frames the panel, which goes with the next messages
 * (`lite/embed.ts`), and a button that leaves it out until the app says something else is open. Nothing outside a frame,
 * or while the app says nothing is open.
 */
export function EmbedContextChip(): ReactNode {
  const { host, context, contextLeftOut } = useEmbed();
  if (host === null || context === null || contextLeftOut) return null;
  const what = describeHostContext(context);
  return (
    <section
      aria-label={`Sent with your messages, from ${host}`}
      data-tour="embed-context"
      className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-t2"
    >
      <span
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-l2 bg-raise pr-0.5 pl-2 max-sm:h-11"
        title={tooltipOf(context)}
      >
        <Eye aria-hidden="true" className="size-3.5 shrink-0 text-t3" />
        <span className="min-w-0 truncate">{what}</span>
        <button
          type="button"
          aria-label="Don't send this"
          title="Don't send this"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-t3 hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring max-sm:size-10"
          onClick={() => embed?.leaveContextOut()}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    </section>
  );
}
