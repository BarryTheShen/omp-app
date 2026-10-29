import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** What a refused link means, in the words a person acts on. */
const REFUSED: Record<NonNullable<ConnectionStateEvent["refusal"]>, string> = {
  expired:
    "This link has expired. Open the app with the link omp-app printed when it last started.",
  invalid: "This link is not valid. Open the app with the link omp-app printed.",
  origin: "The app does not accept connections from this page's address.",
};

/** One banner while the link to the app's server is lost: reconnecting, refused, or closed. */
export function ConnectionBanner({ client }: { readonly client: AppClient }): ReactNode {
  const [state, setState] = useState<ConnectionStateEvent | null>(null);
  useEffect(() => client.onConnectionState(setState), [client]);
  if (state === null || state.state === "open" || state.state === "connecting") return null;
  const reconnecting = state.state === "reconnecting";
  return (
    <div
      role={reconnecting ? "status" : "alert"}
      className="fixed top-3 left-1/2 z-50 flex max-w-[min(90vw,560px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-l3 bg-popover px-3.5 py-2 text-[0.8125rem] text-t1 shadow-lg"
    >
      <span className={`size-1.5 shrink-0 rounded-full ${reconnecting ? "bg-warn" : "bg-bad"}`} />
      <span className="min-w-0">
        {reconnecting
          ? "Reconnecting to the app…"
          : state.refusal !== undefined
            ? REFUSED[state.refusal]
            : "The connection to the app has closed."}
      </span>
      {!reconnecting && state.refusal === undefined && (
        <Button size="xs" variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
