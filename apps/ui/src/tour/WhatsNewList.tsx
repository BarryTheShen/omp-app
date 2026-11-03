import { Check } from "lucide-react";
import { type ReactNode, type RefObject, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { WorkspaceHandle } from "../workspace/Workspace";
import { startTour } from "./runner";
import { isDone } from "./seen";
import { UPDATES } from "./tours";

/** An update's time in the reader's own time zone: "Oct 30, 9:47 PM". */
const timeOf = (when: string): string =>
  new Date(when).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Every update of the app, newest first: when it came, what it added, and its tours, each of which can be taken
 * again. Opened from the footer of the chat list, the What's new card and the palette.
 */
export function WhatsNewList({
  open,
  onOpenChange,
  workspace,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly workspace: RefObject<WorkspaceHandle | null>;
}): ReactNode {
  // The list opens on its title, not on its first button, whose tooltip-free focus ring would mark one tour.
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tour="whats-new-list"
        initialFocus={titleRef}
        // One column no wider than the dialog: a tour's one-line title is cut short there instead of widening the list
        // past a phone's screen.
        className="max-h-[80vh] grid-cols-1 gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <div className="border-b border-l2 px-5 pt-5 pb-3">
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            What's new
          </DialogTitle>
          <p className="mt-1 text-xs text-t3">
            Every update, newest first, with the tours that show it.
          </p>
        </div>
        <ol className="flex flex-col">
          {UPDATES.map((update) => (
            <li key={update.id} className="border-b border-l2 px-5 py-3 last:border-b-0">
              <section aria-label={timeOf(update.when)}>
                <h3 className="text-xs font-medium text-t3">
                  <time dateTime={update.when}>{timeOf(update.when)}</time>
                </h3>
                <p className="mt-0.5 text-[0.8125rem] text-pretty text-t1">{update.summary}</p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {update.tours.map((tour) => {
                    const taken = isDone(tour.id);
                    return (
                      <li key={tour.id} className="flex items-center gap-2 text-[0.8125rem]">
                        <span className="min-w-0 flex-1 truncate text-t2">
                          {tour.title}
                          <span className="text-t3"> · {tour.minutes} min</span>
                        </span>
                        {taken && (
                          <span className="flex items-center gap-1 text-xs text-ok-ink">
                            <Check className="size-3.5" />
                            Taken
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Take the tour: ${tour.title}`}
                          onClick={() => {
                            onOpenChange(false);
                            if (workspace.current !== null) startTour(tour, workspace.current);
                          }}
                        >
                          Take the tour
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
