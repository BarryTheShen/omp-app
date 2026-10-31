import { type ReactNode, type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkspaceHandle } from "../workspace/Workspace";
import { startTours } from "./runner";
import { markOffered, offeredBefore, unoffered } from "./seen";
import { TOURS, type Tour, UPDATES } from "./tours";

/** How many new tours the card names before "and n more". */
const NAMED = 3;

/**
 * A card at the foot of the chat list for what came since the reader last looked: on a first visit the guided tours,
 * after an update the tours it brought, by name. "Take the tour" (or "tours") shows them one after another; "Later"
 * leaves them in the What's new list; either way the card does not come back for them. "All updates" opens the list.
 */
export function WhatsNew({
  workspace,
  onAllUpdates,
}: {
  readonly workspace: RefObject<WorkspaceHandle | null>;
  /** Opens the What's new list. */
  readonly onAllUpdates: () => void;
}): ReactNode {
  const [pending, setPending] = useState<readonly Tour[]>(() => unoffered(TOURS));
  const [firstVisit] = useState(() => !offeredBefore());
  if (pending.length === 0) return null;
  const updates = UPDATES.filter((update) => update.tours.some((tour) => pending.includes(tour)));
  // A first visit takes the basics, the first tour; the list keeps the rest.
  const shown = firstVisit ? pending.slice(0, 1) : pending;

  const dismiss = (): void => {
    markOffered(pending.map((tour) => tour.id));
    setPending([]);
  };

  return (
    <section aria-label="What's new" className="mx-2 mb-2 rounded-xl border border-l2 bg-panel p-3">
      <h2 className="font-medium text-t1">
        {firstVisit
          ? "New: guided tours"
          : updates.length > 1
            ? `New in ${updates.length} updates`
            : "New in this update"}
      </h2>
      {firstVisit ? (
        <p className="mt-1 text-xs text-t2">Learn what's here by doing it, a step at a time.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-t2">
          {pending.slice(0, NAMED).map((tour) => (
            <li key={tour.id} className="truncate">
              {tour.title}
            </li>
          ))}
          {pending.length > NAMED && <li className="text-t3">and {pending.length - NAMED} more</li>}
        </ul>
      )}
      <Button
        variant="link"
        size="sm"
        className="mt-1 h-auto px-0 text-xs text-t3"
        onClick={onAllUpdates}
      >
        All updates
      </Button>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Later
        </Button>
        <Button
          size="sm"
          onClick={() => {
            dismiss();
            if (workspace.current !== null) startTours(shown, workspace.current);
          }}
        >
          {shown.length > 1 ? "Take the tours" : "Take the tour"}
        </Button>
      </div>
    </section>
  );
}
