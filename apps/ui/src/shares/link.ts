import type { AppClient } from "@omp-app/client";
import { AppFailure, SharesPort } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";

/** A ticket counts for a minute: a link is made again before that. */
const RENEW_MS = 45_000;

/**
 * A share's one-time address kept ready (#2788): made now, again every 45 seconds, again after each use, since a ticket
 * signs in one device once, within a minute, and again on `refresh` (the shares changed). Opening it is then a plain link
 * a click follows: a window opened after waiting for an answer is held back as a popup (iOS) or lost (the desktop window
 * opens new windows by the address they start with). `onLink` gets null while there is none, and `ended` for good once
 * the share has ended (#2836): a place that showed it then says so, and offers nothing dead.
 */
export function keepShareLink(
  client: AppClient,
  shareId: string,
  onLink: (url: string | null, ended: boolean) => void,
): { readonly used: () => void; readonly refresh: () => void; readonly stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const make = (): void => {
    clearTimeout(timer);
    if (stopped) return;
    client
      .port(SharesPort)
      .open({ id: shareId })
      .then(
        ({ url }) => {
          if (!stopped) onLink(url, false);
        },
        (failure: unknown) => {
          if (stopped) return;
          // The share ended (stopped, or its service did): there is nothing to link to any more.
          const ended = failure instanceof AppFailure && failure.appError.code === "not_found";
          if (ended) stopped = true;
          onLink(null, ended);
        },
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(make, RENEW_MS);
      });
  };
  make();
  return {
    used: () => {
      if (stopped) return;
      // The ticket in the link was just taken: the next click needs a new one. Made after the click is done: taken
      // away during it, the link would leave the page before the browser follows it, and a link no longer on the page
      // opens nothing.
      setTimeout(() => {
        if (stopped) return;
        onLink(null, false);
        make();
      }, 0);
    },
    refresh: make,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** A share's one-time address for a link, whether the share has ended, and what to call when the link was followed. */
export function useShareLink(
  client: AppClient,
  shareId: string,
): { readonly url: string | null; readonly ended: boolean; readonly used: () => void } {
  const [shown, setShown] = useState<{ readonly url: string | null; readonly ended: boolean }>({
    url: null,
    ended: false,
  });
  const kept = useRef<ReturnType<typeof keepShareLink> | null>(null);
  useEffect(() => {
    const link = keepShareLink(client, shareId, (url, ended) => setShown({ url, ended }));
    kept.current = link;
    return () => link.stop();
  }, [client, shareId]);
  return { url: shown.url, ended: shown.ended, used: () => kept.current?.used() };
}
