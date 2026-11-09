import type { AppClient } from "@omp-app/client";
import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { cn } from "cn";
import { Check, ChevronDown, SquareArrowOutUpRight, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectionBanner } from "../ConnectionBanner";
import { ChatPane } from "../chat/ChatPane";
import { useChatTitle } from "../chat/chatTitle";
import { ChatController, type ChatTarget } from "../chat/controller";
import { firstPromptOf } from "../chat/firstPrompts";
import { useFolder } from "../folders/useFolder";
import { watchLink } from "../linkCheck";
import { titleOf } from "../sidebar/title";
import { type ChatList, useChatList } from "../sidebar/useChatList";
import { setLiteThemeMode } from "../theme/theme";
import { chatCache } from "../workspace/chatCache";
import { bindChat, embed, useEmbed } from "./embed";
import { applyHostLook, BROWSER_CHECKS, hostLook } from "./hostLook";
import { LiteContext } from "./LiteContext";
import { fullAppAddress, liteChat, liteChoices, withEmbedChoices } from "./lite";

/** How many chats the switcher offers: the folder's most recent ones. */
const RECENT_CHATS = 12;

/** The header's buttons: a finger's size on a phone's width and on a tablet, the full app's small size otherwise. */
const HEADER_BUTTON = "size-9 shrink-0 text-t2 max-sm:size-11 tablet:size-11";
/** The header's icons, at the framing app's text size (#2845): 16 px at the app's own 14. */
const HEADER_ICON = "size-[calc(var(--host-text-size,14px)*8/7)]";

/** The chat shown: `key` tells one opening from the next, as a new chat has no id until its first message. */
interface Shown {
  readonly key: string;
  readonly target: ChatTarget;
}

const newChat = (folder: FolderPath): Shown => ({
  key: crypto.randomUUID(),
  target: { kind: "new", folder },
});

/** A chat the switcher offers. */
interface Recent {
  readonly id: ThreadId;
  readonly title: string;
  readonly target: ChatTarget;
}

/** The folder's chats, newest first: the ones whose first reply runs now (omp has not saved them yet), then the saved. */
function recentChats(list: ChatList): readonly Recent[] {
  const starting = list.starting.map(
    (chat): Recent => ({
      id: chat.id,
      title: firstPromptOf(chat.id) ?? "New chat",
      target: { kind: "existing", threadId: chat.id, sessionFile: null },
    }),
  );
  const saved = list.sessions.map(
    (session): Recent => ({
      id: session.id,
      title: titleOf(session),
      target: { kind: "existing", threadId: session.id, sessionFile: session.sessionFile },
    }),
  );
  return [...starting, ...saved].slice(0, RECENT_CHATS);
}

/**
 * The lite view (#2843, `/lite`): one chat and its message box, for another app's side panel, such as a notes app's
 * dock. The app's own server, chats and sign-in; none of its frame: no chat list, workspace, side panels, palette,
 * inbox, tours or settings. The header names the chat and switches to one of the folder's recent chats, starts a new
 * chat, and opens the chat in the full app. Its chats run in the folder the full app chose. Tool cards start folded, as
 * in the full app's chat.
 */
export function LiteShell({
  client,
  launchFolder,
}: {
  readonly client: AppClient;
  readonly launchFolder: FolderPath;
}): ReactNode {
  const { folder } = useFolder(client, launchFolder);
  // The framing app's greeting, suggestions and placeholder (#2845), from the address, then from what it sends.
  const { settings } = useEmbed();
  const choices = useMemo(
    () => withEmbedChoices(liteChoices(window.location.search), settings),
    [settings],
  );
  // The look and mode the page that frames the panel sends (`lite/embed.ts`, started in `main.tsx`).
  useEffect(() => {
    if (settings.look !== undefined) {
      applyHostLook(hostLook(new URLSearchParams(settings.look).toString(), BROWSER_CHECKS));
    }
    if (settings.theme !== undefined)
      setLiteThemeMode(settings.theme === "system" ? null : settings.theme);
  }, [settings]);
  // A link that stopped answering shows as such and is opened again (#2789), as in the full app.
  useEffect(() => watchLink(client), [client]);
  return (
    <div data-app-root="true" className="flex h-full min-w-0 flex-col bg-panel">
      <ConnectionBanner client={client} />
      <LiteContext value={choices}>
        <LiteChats key={folder} client={client} folder={folder} />
      </LiteContext>
    </div>
  );
}

/** The chat shown, from the folder's chats. */
function LiteChats({
  client,
  folder,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
}): ReactNode {
  const list = useChatList(client, folder);
  // The chat the host asked for at load (`?chat=`), else a new one.
  const [shown, setShown] = useState<Shown>(() => {
    const asked = liteChat(window.location.search);
    return asked === null
      ? newChat(folder)
      : {
          key: crypto.randomUUID(),
          target: { kind: "existing", threadId: asked, sessionFile: null },
        };
  });
  /** The controller and the opening it was made for: until the next one is made, the last one is not drawn. */
  const [opened, setOpened] = useState<{
    readonly key: string;
    readonly controller: ChatController;
  } | null>(null);
  // A controller for each chat shown. The chat left stays open a while (`chatCache`), as a window's does, so going back
  // to it shows it at once; a new chat left empty is closed.
  useEffect(() => {
    const kept =
      shown.target.kind === "existing" ? chatCache.take(client, shown.target.threadId) : undefined;
    const next = kept ?? new ChatController(client, shown.target, folder, shown.key);
    setOpened({ key: shown.key, controller: next });
    if (kept === undefined) void next.open();
    return () => chatCache.keep(client, next);
  }, [client, folder, shown]);
  const controller = opened?.key === shown.key ? opened.controller : null;
  if (controller === null) return null;
  return (
    <LiteChat
      key={shown.key}
      controller={controller}
      recent={recentChats(list)}
      onNew={() => {
        // A new chat with nothing in it is the new chat already.
        if (shown.target.kind === "new" && controller.threadId === null) return;
        setShown(newChat(folder));
      }}
      onOpen={(chat) => {
        if (chat.id !== controller.threadId)
          setShown({ key: crypto.randomUUID(), target: chat.target });
      }}
    />
  );
}

function LiteChat({
  controller,
  recent,
  onNew,
  onOpen,
}: {
  readonly controller: ChatController;
  readonly recent: readonly Recent[];
  readonly onNew: () => void;
  readonly onOpen: (chat: Recent) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const title = useChatTitle(controller, snapshot.entries);
  const threadId = controller.threadId;
  // The framing page's tools go to the chat shown here, and to no other (`lite/embed.ts`).
  useEffect(() => (embed === null ? undefined : bindChat(embed, controller)), [controller]);
  return (
    <>
      {/* One line in the framing app's muted colour and text size (#2845): the chat's name, New chat, the full app. */}
      <header className="flex h-11 shrink-0 items-center gap-1 px-1 text-t2">
        <h1 className="flex min-w-0 flex-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              title="Recent chats"
              className="flex min-h-9 max-w-full min-w-0 items-center gap-1 rounded-lg px-2 text-[length:var(--host-text-size,0.875rem)] font-medium text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2 max-sm:min-h-11 tablet:min-h-11"
            >
              <span className="truncate">{title}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-t3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
                {recent.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-t3">No chats in this folder yet.</p>
                ) : (
                  recent.map((chat) => (
                    <DropdownMenuItem key={chat.id} onClick={() => onOpen(chat)}>
                      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                      {chat.id === threadId && <Check aria-label="Shown now" />}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </h1>
        <Button
          variant="ghost"
          size="icon"
          className={HEADER_BUTTON}
          aria-label="New chat"
          title="New chat"
          onClick={onNew}
        >
          <SquarePen className={HEADER_ICON} />
        </Button>
        <a
          href={fullAppAddress(threadId)}
          target="_blank"
          rel="noopener"
          aria-label="Open in the full app"
          title="Open in the full app"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), HEADER_BUTTON)}
        >
          <SquareArrowOutUpRight className={HEADER_ICON} />
        </a>
      </header>
      <ChatPane controller={controller} />
    </>
  );
}
