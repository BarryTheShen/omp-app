import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import { cn } from "cn";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { REFUSED_WORDS } from "./ConnectionBanner";

/** The link's state as the client told it last; the client tells the current one at once. */
export function useConnectionState(client: AppClient): ConnectionStateEvent {
  const [state, setState] = useState<ConnectionStateEvent>({
    state: client.connectionState,
    attempt: 0,
  });
  useEffect(() => client.onConnectionState(setState), [client]);
  return state;
}

const LOOK = {
  connected: { words: "Connected", dot: "bg-ok" },
  connecting: { words: "Connecting…", dot: "bg-warn" },
  reconnecting: { words: "Reconnecting…", dot: "bg-warn" },
  disconnected: { words: "Disconnected", dot: "bg-bad" },
} as const;

/**
 * The link to the app's server, always in sight (#2789): a green dot while connected; amber while it connects or comes
 * back; red once the server refused this page. On a computer it is a line of its own in the sidebar's foot, with its word
 * always shown (`line`); in the phone's foot row it is the dot, with its word only when the link is not well. A click
 * reconnects at once; a refused page reloads instead, which is how it signs in or pairs again.
 */
export function ConnectionDot({
  client,
  line = false,
}: {
  readonly client: AppClient;
  readonly line?: boolean;
}): ReactNode {
  const event = useConnectionState(client);
  const kind =
    event.state === "open" ? "connected" : event.state === "closed" ? "disconnected" : event.state;
  const look = LOOK[kind];
  const worded = line || kind !== "connected";
  const tip =
    kind === "connected"
      ? "Connected to the app. Click to reconnect now."
      : kind === "disconnected"
        ? `${event.refusal === undefined ? "Disconnected from the app." : REFUSED_WORDS[event.refusal]} Click to reload.`
        : `${look.words} Click to reconnect now.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-tour="connection"
            variant="ghost"
            size={worded ? "sm" : "icon-sm"}
            aria-label={`Connection: ${look.words}`}
            className={cn(
              "text-t3 hover:text-t1",
              worded && "gap-1.5 px-2",
              line && "h-7 w-full justify-start font-normal tablet:h-11",
            )}
            onClick={() =>
              event.state === "closed" ? window.location.reload() : client.reconnectNow()
            }
          />
        }
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", look.dot)} />
        {worded && <span className="text-xs">{look.words}</span>}
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}
