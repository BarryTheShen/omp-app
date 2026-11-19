import type { AppClient } from "@omp-app/client";
import { cn } from "cn";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { CONNECTION_LOOK, connectionKind, useConnectionState } from "../ConnectionDot";
import { KEYS } from "../keys/table";
import {
  type Bridge,
  checkDesktopServer,
  type DesktopServers,
  desktopServers,
  forgetDesktopServer,
  openDesktopServer,
  openDesktopServerWindow,
  refusalText,
  renameDesktopServer,
  serverLabel,
} from "./bridge";
import { serverLink } from "./server-link";

/** The menu's value for this computer's own server; a server on another computer is its host. */
const LOCAL = "local";

/** Whether a server answered when the menu last opened: undefined while it is being checked. */
type Reach = Readonly<Record<string, boolean | undefined>>;

/** What the line names the window's server by: the name the person gave it, its host, or this computer. */
export const serverName = (servers: DesktopServers | null): string =>
  servers === null
    ? ""
    : servers.current === null
      ? "This computer"
      : serverLabel(servers, servers.current);

/** A server's reachability as a dot: checking (grey), reachable (green), no answer (red). */
function ReachDot({ reach }: { readonly reach: boolean | undefined }): ReactNode {
  const [colour, words] =
    reach === undefined
      ? ["bg-l2", "Checking"]
      : reach
        ? ["bg-ok", "Reachable"]
        : ["bg-bad", "Not reachable"];
  return (
    <span
      role="img"
      aria-label={words}
      title={words}
      className={cn("size-2 shrink-0 rounded-full", colour)}
    />
  );
}

/**
 * The desktop window's server, in the sidebar's foot, where the connection line was: the link's state and which server
 * the window shows, and one click (or Ctrl+Shift+S) to another. The menu lists this computer's server and every server
 * the window has opened, by the name the person gave it, with whether it answers now; the current one is marked, and
 * picking another moves the window there (the window's own record, never the page's word). Add a server opens a new
 * one with its one-time code in one step; Manage servers names or forgets them; Reconnect now is the connection line's
 * own click, kept here.
 */
export function ServerMenu({
  client,
  bridge,
}: {
  readonly client: AppClient;
  readonly bridge: Bridge;
}): ReactNode {
  const event = useConnectionState(client);
  const kind = connectionKind(event);
  const look = CONNECTION_LOOK[kind];
  const [servers, setServers] = useState<DesktopServers | null>(null);
  const [reach, setReach] = useState<Reach>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);

  const read = useCallback(() => {
    desktopServers(bridge).then(setServers, (failure: unknown) =>
      setProblem(`The servers could not be listed: ${refusalText(failure)}`),
    );
  }, [bridge]);

  useEffect(read, [read]);

  /** Asks the window whether each server answers, as the menu opens. */
  const check = (list: DesktopServers): void => {
    setReach({});
    for (const host of list.remote) {
      if (host === list.current) continue;
      void checkDesktopServer(bridge, host).then((answers) =>
        setReach((was) => ({ ...was, [host]: answers })),
      );
    }
  };

  const move = (value: unknown): void => {
    if (typeof value !== "string" || servers === null) return;
    if (value === (servers.current ?? LOCAL)) return;
    setProblem(null);
    openDesktopServer(
      bridge,
      value === LOCAL ? { kind: "local" } : { kind: "host", host: value },
    ).catch((failure: unknown) => setProblem(refusalText(failure)));
  };

  /** The menu opens (a click on the line, or Ctrl+Shift+S): the list is read again and each server checked. */
  const opened = (): void => {
    setProblem(null);
    desktopServers(bridge).then(
      (list) => {
        setServers(list);
        check(list);
      },
      (failure: unknown) => setProblem(`The servers could not be listed: ${refusalText(failure)}`),
    );
  };

  useHotkeys(
    KEYS.servers.hotkey,
    () => {
      setOpen(true);
      opened();
    },
    { enableOnFormTags: true, preventDefault: true },
  );

  const name = serverName(servers);
  return (
    <div className="flex min-w-0 flex-col">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) opened();
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
          {/* The server first: a long address is cut at its end, never the words that say which server it is. */}
          {name !== "" && (
            <span className="min-w-0 truncate text-xs" title={name}>
              {name}
            </span>
          )}
          <span className="shrink-0 text-xs">{name === "" ? look.words : `· ${look.words}`}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-64 max-w-96">
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
                  <DropdownMenuRadioItem
                    key={host}
                    value={host}
                    closeOnClick
                    aria-label={serverLabel(servers, host)}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {host !== servers.current && <ReachDot reach={reach[host]} />}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{serverLabel(servers, host)}</span>
                        {servers.names[host] !== undefined && (
                          <span className="truncate font-mono text-[0.6875rem] text-t3">
                            {host}
                          </span>
                        )}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAdding(true)}>Add a server…</DropdownMenuItem>
          <DropdownMenuItem
            disabled={servers === null || servers.remote.length === 0}
            onClick={() => setManaging(true)}
          >
            Manage servers…
          </DropdownMenuItem>
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
      {servers !== null && (
        <ManageServers
          bridge={bridge}
          servers={servers}
          open={managing}
          onOpenChange={setManaging}
          onChanged={read}
        />
      )}
      <AddServer bridge={bridge} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/**
 * Adds a server in one step: its address and, when this window has not paired with it, a one-time code from it. The
 * window opens the server with the code, and its pairing screen pairs at once; without a code, the pairing screen asks.
 * A refused address is said here, and the dialog stays.
 */
function AddServer({
  bridge,
  open,
  onOpenChange,
}: {
  readonly bridge: Bridge;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const link = serverLink(address, code);
    if (link === null) {
      setProblem("Type the server's address, for example omp.example.com.");
      return;
    }
    setProblem(null);
    setMoving(true);
    openDesktopServer(bridge, { kind: "link", link }).catch((failure: unknown) => {
      setMoving(false);
      setProblem(refusalText(failure));
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            The server's address, and a one-time code from it if this app has not paired with it. On
            that server, the code is in Settings → App → Devices → Pair a new device.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-t2">
            Server address
            <Input
              value={address}
              onChange={(change) => setAddress(change.target.value)}
              placeholder="omp.example.com"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-t2">
            One-time code (optional)
            <Input
              value={code}
              onChange={(change) => setCode(change.target.value)}
              placeholder="ABCD 1234"
              spellCheck={false}
              autoComplete="one-time-code"
              className="font-mono text-xs uppercase"
            />
          </label>
          {problem !== null && (
            <p role="alert" className="text-xs text-bad-ink [overflow-wrap:anywhere]">
              {problem}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={moving || address.trim() === ""}>
              {moving ? "Opening…" : "Add and open"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One server in Manage servers: its name, its address, and Forget (not for the server the window shows). */
function ManagedServer({
  bridge,
  servers,
  host,
  onChanged,
}: {
  readonly bridge: Bridge;
  readonly servers: DesktopServers;
  readonly host: string;
  readonly onChanged: () => void;
}): ReactNode {
  const [name, setName] = useState(servers.names[host] ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const current = host === servers.current;

  const save = (): void => {
    if (name.trim() === (servers.names[host] ?? "")) return;
    setProblem(null);
    renameDesktopServer(bridge, host, name).then(onChanged, (failure: unknown) =>
      setProblem(refusalText(failure)),
    );
  };

  return (
    <li className="border-b border-l1 py-3 last:border-b-0">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-mono text-xs text-t3">{host}</span>
          <Input
            value={name}
            maxLength={40}
            placeholder="Name (optional)"
            aria-label={`Name of ${host}`}
            onChange={(change) => setName(change.target.value)}
            onBlur={save}
            onKeyDown={(key) => {
              if (key.key === "Enter") save();
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Open ${serverLabel(servers, host)} in a new window`}
          onClick={() => {
            setProblem(null);
            openDesktopServerWindow(bridge, host).catch((failure: unknown) =>
              setProblem(refusalText(failure)),
            );
          }}
        >
          New window
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={current}
          title={current ? "This window shows this server; open another one first." : undefined}
          onClick={() => {
            setProblem(null);
            forgetDesktopServer(bridge, host).then(onChanged, (failure: unknown) =>
              setProblem(refusalText(failure)),
            );
          }}
        >
          Forget
        </Button>
      </div>
      {current && <p className="mt-1 text-xs text-t3">Shown in this window.</p>}
      {problem !== null && (
        <p role="alert" className="mt-1 text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </li>
  );
}

/** Names or forgets the servers the window opened before. */
function ManageServers({
  bridge,
  servers,
  open,
  onOpenChange,
  onChanged,
}: {
  readonly bridge: Bridge;
  readonly servers: DesktopServers;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => void;
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage servers</DialogTitle>
          <DialogDescription>
            Name the servers this app has opened, open one in a new window, or forget one. A
            forgotten server can be opened again with its address.
          </DialogDescription>
        </DialogHeader>
        <ul aria-label="Servers" className="max-h-80 overflow-y-auto">
          {servers.remote.map((host) => (
            <ManagedServer
              key={host}
              bridge={bridge}
              servers={servers}
              host={host}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
