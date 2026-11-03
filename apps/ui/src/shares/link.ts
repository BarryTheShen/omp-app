import type { AppClient } from "@omp-app/client";
import { AppFailure, SharesPort } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";

/** A ticket counts for a minute: a link is made again before that. */
const RENEW_MS = 45_000;

/**
 * A share's one-time address kept ready (#2788): made now, again every 45 seconds, and again after each use, since a
 * ticket signs in one device once, within a minute. Opening it is then a plain link a click follows: a window opened
 * after waiting for an answer is held back as a popup (iOS) or lost (the desktop window opens new windows by the address
 * they start with). `onLink` gets null while there is none, and for good once the share has ended.
 */
export function keepShareLink(
  client: AppClient,
  shareId: string,
  onLink: (url: string | null) => void,
): { readonly used: () => void; readonly stop: () => void } {
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
          if (!stopped) onLink(url);
        },
        (failure: unknown) => {
          if (stopped) return;
          onLink(null);
          // The share ended (stopped, or its service did): there is nothing to link to any more.
          if (failure instanceof AppFailure && failure.appError.code === "not_found")
            stopped = true;
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
        onLink(null);
        make();
      }, 0);
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** A share's one-time address for a link, and what to call when the link was followed. */
export function useShareLink(
  client: AppClient,
  shareId: string,
): { readonly url: string | null; readonly used: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const kept = useRef<ReturnType<typeof keepShareLink> | null>(null);
  useEffect(() => {
    const link = keepShareLink(client, shareId, setUrl);
    kept.current = link;
    return () => link.stop();
  }, [client, shareId]);
  return { url, used: () => kept.current?.used() };
}
