import type { AppClient } from "@omp-app/client";
import { AppPort, type FolderPath, type SessionFile, SessionFileStore } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ConnectionBanner } from "./ConnectionBanner";
import type { ChatTarget } from "./chat/controller";
import { connect, readToken } from "./connection";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { Workspace, type WorkspaceHandle, type WorkspaceView } from "./workspace/Workspace";

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "no-link" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly client: AppClient; readonly folder: FolderPath };

/** Tailwind's `sm` breakpoint: below it, one pane. */
const PHONE = "(max-width: 639px)";

function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia(PHONE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => matchMedia(PHONE).matches,
  );
}

const NOTHING_OPEN: WorkspaceView = { focused: null, open: new Set(), waiting: new Set() };

/**
 * The launch folder's chats beside the workspace of chat panes (kitty's tabs and splits); on a phone, the list or one
 * chat. A click opens a chat in the focused pane, Alt+click beside it.
 */
export function App(): ReactNode {
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  const [sessions, setSessions] = useState<readonly SessionFile[]>([]);
  const [view, setView] = useState<WorkspaceView>(NOTHING_OPEN);
  /** On a phone: the list of chats, or the chat. */
  const [showChat, setShowChat] = useState(false);
  const workspace = useRef<WorkspaceHandle>(null);
  const phone = usePhone();

  useEffect(() => {
    const token = readToken();
    if (token === null) {
      setConnection({ kind: "no-link" });
      return;
    }
    const client = connect(token);
    let active = true;
    void (async () => {
      try {
        const info = await client.port(AppPort).serverInfo({});
        if (!active) return;
        setConnection({ kind: "ready", client, folder: info.launchFolder });
        const listed = await client
          .port(SessionFileStore)
          .listSessions({ folder: info.launchFolder, limit: 50 });
        if (active) setSessions(listed.sessions);
      } catch (error) {
        if (active)
          setConnection({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      active = false;
      client.dispose();
    };
  }, []);

  if (connection.kind === "no-link") {
    return <Note>Open the app with the link omp-app printed.</Note>;
  }
  if (connection.kind === "failed") {
    return <Note>Could not reach the app: {connection.message}</Note>;
  }
  if (connection.kind === "connecting") {
    return <Note>Connecting…</Note>;
  }
  const folder = connection.folder;
  const openChat = (target: ChatTarget, where: "here" | "split"): void => {
    workspace.current?.open(target, where);
    setShowChat(true);
  };
  return (
    <div
      className="grid h-full grid-cols-[244px_minmax(0,1fr)] max-[1360px]:grid-cols-[224px_minmax(0,1fr)] max-sm:grid-cols-1"
      data-app-root="true"
    >
      <ConnectionBanner client={connection.client} />
      <nav
        aria-label="Chats"
        className={cn("flex min-h-0 flex-col p-2", phone && showChat && "hidden")}
      >
        <Button
          variant="ghost"
          className="justify-start gap-2 px-2 text-t2 hover:text-t1"
          onClick={() => openChat({ kind: "new", folder }, "here")}
        >
          <SquarePen />
          New chat
        </Button>
        <div className="px-2 pt-4 pb-1 text-xs font-medium text-t3">Chats</div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((session) => {
            const title =
              session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat";
            const open = view.open.has(session.id);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:bg-l2 aria-[current=true]:text-t1 max-sm:h-11"
                  aria-current={session.id === view.focused ? "true" : undefined}
                  // One phrase for a screen reader: the title, and whether a pane shows it.
                  aria-label={open ? `${title}, open in a pane` : title}
                  onClick={(event) =>
                    openChat(
                      { kind: "existing", threadId: session.id, sessionFile: session.sessionFile },
                      event.altKey ? "split" : "here",
                    )
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {open && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-t3" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex px-1 pt-2">
          <ThemeSwitch />
        </div>
      </nav>
      <main
        className={cn(
          "my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-l2 bg-panel max-sm:m-0 max-sm:rounded-none max-sm:border-0",
          phone && !showChat && "hidden",
        )}
      >
        {phone && (
          <div className="flex px-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-t2"
              onClick={() => setShowChat(false)}
            >
              <ChevronLeft />
              Chats
            </Button>
          </div>
        )}
        <Workspace
          ref={workspace}
          client={connection.client}
          folder={folder}
          phone={phone}
          onView={setView}
        />
      </main>
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="grid h-full place-items-center px-6 text-center text-t3">{children}</p>;
}
