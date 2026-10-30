import { type ReactNode, type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkspaceHandle } from "../workspace/Workspace";
import { startTour } from "./runner";
import { markOffered, unoffered } from "./seen";
import { TOURS, type Tour } from "./tours";

/**
 * A card in the sidebar, above its footer row, for the tours the app has not offered yet: "Take the tour" starts the
 * first, "Later" closes the card. Either way the tours count as offered, so the card does not come back; the palette
 * keeps every tour.
 */
export function WhatsNew({
  workspace,
}: {
  readonly workspace: RefObject<WorkspaceHandle | null>;
}): ReactNode {
  const [pending, setPending] = useState<readonly Tour[]>(() => unoffered(TOURS));
  const [first] = pending;
  if (first === undefined) return null;

  const dismiss = (): void => {
    markOffered(pending.map((tour) => tour.id));
    setPending([]);
  };

  return (
    <section aria-label="What's new" className="mx-2 mb-2 rounded-xl border border-l2 bg-panel p-3">
      <h2 className="font-medium text-t1">
        {pending.length > 1 ? "New: guided tours" : `New: ${first.title}`}
      </h2>
      <p className="mt-1 text-xs text-t2">Learn what's here by doing it, a step at a time.</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Later
        </Button>
        <Button
          size="sm"
          onClick={() => {
            dismiss();
            if (workspace.current !== null) startTour(first, workspace.current);
          }}
        >
          Take the tour
        </Button>
      </div>
    </section>
  );
}
