import { Eye, X } from "lucide-react";
import type { ReactNode } from "react";
import { embed, useEmbed } from "./embed";

/**
 * Above the lite view's message box: what is open in the app that frames the panel, which goes with the next messages
 * (`lite/embed.ts`), and a button that leaves it out until the app says something else is open. Nothing outside a frame,
 * or while the app says nothing is open.
 */
export function EmbedContextChip(): ReactNode {
  const { host, context, contextLeftOut } = useEmbed();
  if (host === null || context === null || contextLeftOut) return null;
  const what = context.selection === undefined ? context.title : `${context.title} (a selection)`;
  return (
    <section
      aria-label={`Sent with your messages, from ${host}`}
      data-tour="embed-context"
      className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-t2"
    >
      <span
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-l2 bg-raise pr-0.5 pl-2 max-sm:h-11"
        title={context.uri ?? context.title}
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
