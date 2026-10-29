import type { AppClient } from "@omp-app/client";
import { AppPort, type FolderPath, type SessionFile, SessionFileStore } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChatPane } from "./chat/ChatPane";
import { ChatController, type ChatTarget } from "./chat/controller";
import { connect, readToken } from "./connection";
import { ThemeSwitch } from "./theme/ThemeSwitch";

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "no-link" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly client: AppClient; readonly folder: FolderPath };

/**
 * A list of the launch folder's chats beside one chat; on a phone, the list or the chat. The workspace comes in V5.
 */
export function App(): ReactNode {
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  const [sessions, setSessions] = useState<readonly SessionFile[]>([]);
  const [target, setTarget] = useState<ChatTarget | null>(null);
  const [controller, setController] = useState<ChatController | null>(null);

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

  useEffect(() => {
    if (connection.kind !== "ready" || target === null) {
      setController(null);
      return;
    }
    const next = new ChatController(connection.client, target);
    setController(next);
    void next.open();
    return () => {
      void next.dispose();
    };
  }, [connection, target]);

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
  const selected = target?.kind === "existing" ? target.threadId : null;
  const chatOpen = controller !== null;
  return (
    <div
      className="grid h-full grid-cols-[244px_minmax(0,1fr)] max-[1360px]:grid-cols-[224px_minmax(0,1fr)] max-sm:grid-cols-1"
      data-app-root="true"
    >
      <nav
        aria-label="Chats"
        className={cn("flex min-h-0 flex-col p-2", chatOpen && "max-sm:hidden")}
      >
        <Button
          variant="ghost"
          className="justify-start gap-2 px-2 text-t2 hover:text-t1"
          onClick={() => setTarget({ kind: "new", folder })}
        >
          <SquarePen />
          New chat
        </Button>
        <div className="px-2 pt-4 pb-1 text-xs font-medium text-t3">Chats</div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="flex h-8 w-full items-center rounded-md px-2 text-left text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:bg-l2 aria-[current=true]:text-t1 max-sm:h-11"
                aria-current={session.id === selected ? "true" : undefined}
                onClick={() =>
                  setTarget({
                    kind: "existing",
                    threadId: session.id,
                    sessionFile: session.sessionFile,
                  })
                }
              >
                <span className="truncate">
                  {session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex px-1 pt-2">
          <ThemeSwitch />
        </div>
      </nav>
      <main
        className={cn(
          "my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-l2 bg-panel max-sm:m-0 max-sm:rounded-none max-sm:border-0",
          !chatOpen && "max-sm:hidden",
        )}
      >
        {controller === null ? (
          <p className="m-auto text-t3">Pick a chat or start a new one.</p>
        ) : (
          <>
            <div className="flex px-2 pt-2 sm:hidden">
              <Button variant="ghost" size="sm" className="text-t2" onClick={() => setTarget(null)}>
                <ChevronLeft />
                Chats
              </Button>
            </div>
            <ChatPane key={controller.threadId ?? "new"} controller={controller} />
          </>
        )}
      </main>
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="grid h-full place-items-center px-6 text-center text-t3">{children}</p>;
}
