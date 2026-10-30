import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type Bridge,
  type DesktopServers,
  desktopBridge,
  desktopServers,
  openDesktopServer,
  refusalText,
  type ServerChoice,
} from "./bridge";

/** What the palette and the Server section call this computer's server and another computer's. */
export const LOCAL_SERVER_LABEL = "Use this computer's server";
export const remoteServerLabel = (host: string): string => `Open the server on ${host}`;

/**
 * The App tab's Server section. In the desktop window: this computer's server and the servers on other computers the
 * window opened, each one click away, and a pasted link to another (`focusLink` puts the cursor there). In a browser:
 * the server the page came from.
 */
export function ServerSection({ focusLink }: { readonly focusLink: boolean }): ReactNode {
  const bridge = desktopBridge();
  return (
    <>
      <h3 className="mt-6 text-xs font-medium text-t3">Server</h3>
      {bridge === null ? (
        <div className="flex items-center gap-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-t1">Connected to</p>
          <p className="truncate font-mono text-xs text-t2">{window.location.host}</p>
        </div>
      ) : (
        <WindowServers bridge={bridge} focusLink={focusLink} />
      )}
    </>
  );
}

function WindowServers({
  bridge,
  focusLink,
}: {
  readonly bridge: Bridge;
  readonly focusLink: boolean;
}): ReactNode {
  const [servers, setServers] = useState<DesktopServers | null>(null);
  const [link, setLink] = useState("");
  /** A move asked for: the window leaves this page when it is done. */
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    desktopServers(bridge).then(
      (found) => alive && setServers(found),
      (failure: unknown) =>
        alive && setProblem(`The window's servers could not be read: ${refusalText(failure)}`),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (focusLink) field.current?.focus();
  }, [focusLink]);

  const open = (choice: ServerChoice): void => {
    setProblem(null);
    setMoving(true);
    openDesktopServer(bridge, choice).catch((failure: unknown) => {
      setMoving(false);
      setProblem(refusalText(failure));
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (link.trim() !== "") open({ kind: "link", link: link.trim() });
  };
  const row = (
    key: string,
    name: ReactNode,
    current: boolean,
    label: string,
    choice: ServerChoice,
  ) => (
    <div key={key} className="flex items-center gap-4 border-b border-l1 py-3">
      <div className="min-w-0 flex-1 truncate text-sm text-t1">{name}</div>
      {current ? (
        <p className="text-xs text-t3">Open now</p>
      ) : (
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          disabled={moving}
          onClick={() => open(choice)}
        >
          Open
        </Button>
      )}
    </div>
  );

  return (
    <>
      {servers !== null &&
        row("local", "This computer", servers.current === null, LOCAL_SERVER_LABEL, {
          kind: "local",
        })}
      {servers?.remote.map((host) =>
        row(
          `remote:${host}`,
          <span className="font-mono text-xs">{host}</span>,
          servers.current === host,
          remoteServerLabel(host),
          { kind: "host", host },
        ),
      )}
      <form onSubmit={submit} className="py-3">
        <label htmlFor="server-link" className="text-sm text-t1">
          Connect to another server
        </label>
        <p className="mt-0.5 text-xs text-t3">
          Paste the link the other computer's omp-app printed for other devices.
        </p>
        <div className="mt-2 flex gap-2">
          <Input
            ref={field}
            id="server-link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://<computer>.<tailnet>.ts.net/#token=…"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={moving || link.trim() === ""}>
            Connect
          </Button>
        </div>
        {problem !== null && (
          <p role="alert" className="mt-2 text-sm text-bad-ink">
            {problem}
          </p>
        )}
      </form>
    </>
  );
}
