import type { AppClient } from "@omp-app/client";
import { AppPort, type FolderPath } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ConnectionBanner } from "./ConnectionBanner";
import type { ChatTarget } from "./chat/controller";
import { connect, readToken } from "./connection";
import { Sidebar } from "./sidebar/Sidebar";
import { useChatList } from "./sidebar/useChatList";
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

/** Connects with the page's launch link, then shows the app. */
export function App(): ReactNode {
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });

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
        if (active) setConnection({ kind: "ready", client, folder: info.launchFolder });
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
  return <Shell client={connection.client} folder={connection.folder} />;
}

/**
 * The launch folder's chats beside the workspace of chat panes (kitty's tabs and splits); on a phone, the list or one
 * chat. A click opens a chat in the focused pane, Alt+click beside it.
 */
function Shell({
  client,
  folder,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
}): ReactNode {
  const list = useChatList(client, folder);
  const [view, setView] = useState<WorkspaceView>(NOTHING_OPEN);
  /** On a phone: the list of chats, or the chat. */
  const [showChat, setShowChat] = useState(false);
  const workspace = useRef<WorkspaceHandle>(null);
  const phone = usePhone();
  const openChat = (target: ChatTarget, where: "here" | "split"): void => {
    workspace.current?.open(target, where);
    setShowChat(true);
  };
  return (
    <div
      className="grid h-full grid-cols-[244px_minmax(0,1fr)] max-[1360px]:grid-cols-[224px_minmax(0,1fr)] max-sm:grid-cols-1"
      data-app-root="true"
    >
      <ConnectionBanner client={client} />
      <Sidebar
        folder={folder}
        list={list}
        view={view}
        hidden={phone && showChat}
        onOpen={openChat}
      />
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
        <Workspace ref={workspace} client={client} folder={folder} phone={phone} onView={setView} />
      </main>
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="grid h-full place-items-center px-6 text-center text-t3">{children}</p>;
}
