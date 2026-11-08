import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { lastReturnAt, onReturn } from "./linkCheck";
import { reloadKeepingChat } from "./reloadKeepsChat";
import { useAppUpdated } from "./update";

/** What a refused link means, in the words a person acts on. */
export const REFUSED_WORDS: Record<NonNullable<ConnectionStateEvent["refusal"]>, string> = {
  expired:
    "This link has expired. Open the app with the link omp-app printed when it last started.",
  invalid: "This link is not valid. Open the app with the link omp-app printed.",
  unpaired: "This device is not paired with the app. Reload the page to pair it.",
  origin: "The app does not accept connections from this page's address.",
};

/**
 * The banner's place: under the status bar, over the page; on a phone under its top bar instead, so ‹ Chats, Details and
 * New chat stay in reach while it shows (#2818).
 */
const PLACE =
  "fixed top-[calc(var(--safe-top)+0.75rem)] max-sm:top-[calc(var(--safe-top)+2.75rem+0.5rem)] left-[calc(50%+(var(--safe-left)-var(--safe-right))/2)] z-50 flex w-max max-w-[min(calc(90vw-var(--safe-left)-var(--safe-right)),560px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-l3 bg-popover px-3.5 py-2 text-[0.8125rem] text-t1 shadow-lg";

/**
 * A link down this long shows the banner. A blip on the network reconnects in about a second, which the connection dot
 * shows: the banner is for a link that stays down.
 */
export const BANNER_AFTER_MS = 2_000;
/**
 * Right after the page comes back (a phone back from another app, a laptop awake again), the banner waits this long
 * from that moment: the phone's new link took 1 to 5 seconds on Nov 7 (its network wakes first), which the dot shows.
 */
export const BANNER_AFTER_RETURN_MS = 6_000;

/**
 * One banner while the link to the app's server is lost (reconnecting for 2 seconds or more and 6 seconds after the
 * page came back, refused, or closed), or, while it is fine, once the app was updated after this page loaded (#2787):
 * the page runs its own build until it reloads.
 */
export function ConnectionBanner({ client }: { readonly client: AppClient }): ReactNode {
  const [state, setState] = useState<ConnectionStateEvent | null>(null);
  useEffect(() => client.onConnectionState(setState), [client]);
  const updated = useAppUpdated(client);
  const reconnecting = state?.state === "reconnecting";
  const [long, setLong] = useState(false);
  const [returns, setReturns] = useState(0);
  useEffect(() => onReturn(() => setReturns((count) => count + 1)), []);
  const reconnectingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!reconnecting) {
      reconnectingSince.current = null;
      setLong(false);
      return;
    }
    reconnectingSince.current ??= Date.now();
    const back = lastReturnAt();
    const showAt = Math.max(
      reconnectingSince.current + BANNER_AFTER_MS,
      back === null ? Number.NEGATIVE_INFINITY : back + BANNER_AFTER_RETURN_MS,
    );
    const wait = showAt - Date.now();
    setLong(wait <= 0);
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setLong(true), wait);
    return () => window.clearTimeout(timer);
  }, [reconnecting, returns]);
  if (
    state === null ||
    state.state === "open" ||
    state.state === "connecting" ||
    (reconnecting && !long)
  ) {
    if (!updated) return null;
    return (
      <div role="status" className={PLACE}>
        <span className="size-1.5 shrink-0 rounded-full bg-accent-ink" />
        <span className="min-w-0">The app was updated. Reload to use the new version.</span>
        <Button size="xs" variant="secondary" onClick={reloadKeepingChat}>
          Reload
        </Button>
      </div>
    );
  }
  // Still reconnecting after the wait: the banner says so and offers to try at once.
  return (
    <div role={reconnecting ? "status" : "alert"} className={PLACE}>
      <span className={`size-1.5 shrink-0 rounded-full ${reconnecting ? "bg-warn" : "bg-bad"}`} />
      <span className="min-w-0">
        {reconnecting
          ? "Reconnecting to the app…"
          : state.refusal !== undefined
            ? REFUSED_WORDS[state.refusal]
            : "The connection to the app has closed."}
      </span>
      {reconnecting && (
        <Button size="xs" variant="secondary" onClick={() => client.reconnectNow()}>
          Reconnect now
        </Button>
      )}
      {!reconnecting && state.refusal === undefined && (
        <Button size="xs" variant="secondary" onClick={reloadKeepingChat}>
          Reload
        </Button>
      )}
    </div>
  );
}
