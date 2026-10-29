import type { AppClient } from "@omp-app/client";
import { AppPort, type FolderPath, type SessionFile, SessionFileStore } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { ChatPane } from "./chat/ChatPane";
import { ChatController, type ChatTarget } from "./chat/controller";
import { connect, readToken } from "./connection";

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "no-link" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly client: AppClient; readonly folder: FolderPath };

/** V1: a plain list of the launch folder's chats beside one chat. The workspace comes in V5. */
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
    if (connection.kind !== "ready" || target === null) return;
    const next = new ChatController(connection.client, target);
    setController(next);
    void next.open();
    return () => {
      void next.dispose();
    };
  }, [connection, target]);

  if (connection.kind === "no-link") {
    return <p className="app-note">Open the app with the link omp-app printed.</p>;
  }
  if (connection.kind === "failed") {
    return <p className="app-note">Could not reach the app: {connection.message}</p>;
  }
  if (connection.kind === "connecting") {
    return <p className="app-note">Connecting…</p>;
  }
  const folder = connection.folder;
  const selected = target?.kind === "existing" ? target.threadId : null;
  return (
    <div className="app" data-app-root="true">
      <nav className="sidebar" aria-label="Chats">
        <button
          type="button"
          className="sidebar-new"
          onClick={() => setTarget({ kind: "new", folder })}
        >
          New chat
        </button>
        <ul className="sidebar-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="sidebar-item"
                aria-current={session.id === selected ? "true" : undefined}
                onClick={() =>
                  setTarget({
                    kind: "existing",
                    threadId: session.id,
                    sessionFile: session.sessionFile,
                  })
                }
              >
                {session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat"}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="main">
        {controller === null ? (
          <p className="app-note">Pick a chat or start a new one.</p>
        ) : (
          <ChatPane key={controller.threadId ?? "new"} controller={controller} />
        )}
      </main>
    </div>
  );
}
