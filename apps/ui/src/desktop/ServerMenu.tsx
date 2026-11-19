import type { AppClient } from "@omp-app/client";
import { cn } from "cn";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONNECTION_LOOK, connectionKind, useConnectionState } from "../ConnectionDot";
import {
  type Bridge,
  type DesktopServers,
  desktopServers,
  openDesktopServer,
  refusalText,
} from "./bridge";

/** The menu's value for this computer's own server; a server on another computer is its host. */
const LOCAL = "local";

/** What the line names the window's server by: its host, or this computer. */
export const serverName = (servers: DesktopServers | null): string =>
  servers === null ? "" : (servers.current ?? "This computer");

/**
 * The desktop window's server, in the sidebar's foot, where the connection line was: the link's state and which server
 * the window shows, and one click to another. The menu lists this computer's server and every server the window has
 * opened, the current one marked; picking one moves the window there (the window's own record, never the page's word).
 * Connect to another server opens Settings → App with its address field, for a server not opened before. Reconnect now
 * is the connection line's own click, kept here.
 */
export function ServerMenu({
  client,
  bridge,
  onServers,
}: {
  readonly client: AppClient;
  readonly bridge: Bridge;
  /** Opens Settings → App at the field for another server's address. */
  readonly onServers: () => void;
}): ReactNode {
  const event = useConnectionState(client);
  const kind = connectionKind(event);
  const look = CONNECTION_LOOK[kind];
  const [servers, setServers] = useState<DesktopServers | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(() => {
    desktopServers(bridge).then(setServers, (failure: unknown) =>
      setProblem(`The servers could not be listed: ${refusalText(failure)}`),
    );
  }, [bridge]);

  useEffect(read, [read]);

  const move = (value: unknown): void => {
    if (typeof value !== "string" || servers === null) return;
    if (value === (servers.current ?? LOCAL)) return;
    setProblem(null);
    openDesktopServer(
      bridge,
      value === LOCAL ? { kind: "local" } : { kind: "host", host: value },
    ).catch((failure: unknown) => setProblem(refusalText(failure)));
  };

  const name = serverName(servers);
  return (
    <div className="flex min-w-0 flex-col">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          setProblem(null);
          read();
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              data-tour="connection"
              variant="ghost"
              size="sm"
              aria-label={`Server: ${name || "this window's"}. Connection: ${look.words}`}
              className="h-7 w-full min-w-0 justify-start gap-1.5 px-2 font-normal text-t3 hover:text-t1 tablet:h-11"
            />
          }
        >
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", look.dot)} />
          <span className="shrink-0 text-xs">{look.words}</span>
          {name !== "" && (
            <span className="min-w-0 truncate text-xs" title={name}>
              · {name}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-60 max-w-96">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Server</DropdownMenuLabel>
            {servers === null ? (
              <p className="px-1.5 py-1 text-sm text-t3">Loading servers…</p>
            ) : (
              <DropdownMenuRadioGroup value={servers.current ?? LOCAL} onValueChange={move}>
                {/* A pick closes the menu: the window moves, or the problem shows under the line. */}
                <DropdownMenuRadioItem value={LOCAL} closeOnClick>
                  This computer
                </DropdownMenuRadioItem>
                {servers.remote.map((host) => (
                  <DropdownMenuRadioItem key={host} value={host} closeOnClick>
                    <span className="truncate font-mono text-xs">{host}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onServers}>Connect to another server…</DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              event.state === "closed" ? window.location.reload() : client.reconnectNow()
            }
          >
            {event.state === "closed" ? "Reload" : "Reconnect now"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {problem !== null && (
        <p role="alert" className="px-2 pt-1 text-xs text-bad-ink [overflow-wrap:anywhere]">
          {problem}
        </p>
      )}
    </div>
  );
}
