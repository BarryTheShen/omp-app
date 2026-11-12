import type { AppClient } from "@omp-app/client";
import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { cn } from "cn";
import { Check, ChevronDown, SquareArrowOutUpRight, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConnectionBanner } from "../ConnectionBanner";
import { ChatPane } from "../chat/ChatPane";
import { useChatTitle } from "../chat/chatTitle";
import { ChatController, type ChatTarget } from "../chat/controller";
import { firstPromptOf } from "../chat/firstPrompts";
import { LinkReopens } from "../chat/reopens";
import { useFolder } from "../folders/useFolder";
import { watchLink } from "../linkCheck";
import { titleOf } from "../sidebar/title";
import { type ChatList, useChatList } from "../sidebar/useChatList";
import { setLiteThemeMode } from "../theme/theme";
import { chatCache } from "../workspace/chatCache";
import { bindChat, embed, useEmbed } from "./embed";
import { applyHostLook, BROWSER_CHECKS, hostLook } from "./hostLook";
import { LiteContext } from "./LiteContext";
import {
  desktopAppLink,
  type FullAppPlace,
  fullAppAddress,
  fullAppPlace,
  keepFullAppPlace,
  liteChat,
  liteChoices,
  withEmbedChoices,
} from "./lite";
import { type FolderChat, switcherChats } from "./switcher";

/** The header's buttons: a finger's size on a phone's width and on a tablet, the full app's small size otherwise. */
const HEADER_BUTTON = "size-9 shrink-0 text-t2 max-sm:size-11 tablet:size-11";
/** The header's icons, at the framing app's text size (#2845): 16 px at the app's own 14. */
const HEADER_ICON = "size-[calc(var(--host-text-size,14px)*8/7)]";

/** The chat shown: `key` tells one opening from the next, as a new chat has no id until its first message. */
interface Shown {
  readonly key: string;
  readonly target: ChatTarget;
  /** The chat the page's address named at load (`?chat=`), as against one the person chose. */
  readonly askedAtLoad?: true;
}

const newChat = (folder: FolderPath): Shown => ({
  key: crypto.randomUUID(),
  target: { kind: "new", folder },
});

/** The folder's chats, newest first: the ones whose first reply runs now (omp has not saved them yet), then the saved. */
function folderChats(list: ChatList): readonly FolderChat[] {
  const starting = list.starting.map(
    (chat): FolderChat => ({
      id: chat.id,
      title: firstPromptOf(chat.id) ?? "New chat",
      target: { kind: "existing", threadId: chat.id, sessionFile: null },
    }),
  );
  const saved = list.sessions.map(
    (session): FolderChat => ({
      id: session.id,
      title: titleOf(session),
      target: { kind: "existing", threadId: session.id, sessionFile: session.sessionFile },
    }),
  );
  return [...starting, ...saved];
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
          askedAtLoad: true,
        };
  });
  /** Each fresh open of the chat shown (Try again, or the link back): a new controller for the same chat. */
  const [attempt, setAttempt] = useState(0);
  const [reopens] = useState(() => new LinkReopens());
  /** The controller and the opening it was made for: until the next one is made, the last one is not drawn. */
  const [opened, setOpened] = useState<{
    readonly key: string;
    readonly attempt: number;
    readonly controller: ChatController;
  } | null>(null);
  // A controller for each chat shown. The chat left stays open a while (`chatCache`), as a window's does, so going back
  // to it shows it at once; a new chat left empty is closed. A chat that could not open asks for a fresh open (Try
  // again, or the link back) or a new chat.
  useEffect(() => {
    const kept =
      shown.target.kind === "existing" ? chatCache.take(client, shown.target.threadId) : undefined;
    const next = kept ?? new ChatController(client, shown.target, folder, shown.key);
    setOpened({ key: shown.key, attempt, controller: next });
    // The chat the address named at load, if the server no longer has it (a chat nobody wrote in is stopped and forgotten
    // after a while), is replaced by a new one with nothing said. Its first open only: any other failure, and any
    // later open, keeps Try again and New chat.
    if (kept === undefined)
      void next.open(shown.askedAtLoad === true && attempt === 0 ? { newChatIfGone: true } : {});
    const stopAsks = next.onPaneAsk((ask) => {
      if (ask.kind === "new-chat") {
        setShown(newChat(folder));
        return;
      }
      if (ask.by === "person") reopens.reset();
      else if (!reopens.take(shown.key)) return;
      setAttempt((count) => count + 1);
    });
    return () => {
      stopAsks();
      chatCache.keep(client, next);
    };
  }, [client, folder, shown, attempt, reopens]);
  const controller =
    opened?.key === shown.key && opened.attempt === attempt ? opened.controller : null;
  if (controller === null) return null;
  return (
    <LiteChat
      key={`${shown.key}:${attempt}`}
      controller={controller}
      existing={shown.target.kind === "existing"}
      chats={folderChats(list)}
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
  existing,
  chats,
  onNew,
  onOpen,
}: {
  readonly controller: ChatController;
  /** The chat was opened as one that exists, by its id: its address names it from the start. */
  readonly existing: boolean;
  readonly chats: readonly FolderChat[];
  readonly onNew: () => void;
  readonly onOpen: (chat: FolderChat) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const title = useChatTitle(controller, snapshot.entries);
  const threadId = controller.threadId;
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState("");
  const listed = switcherChats(chats, query);
  // The framing page's tools go to the chat shown here, and to no other (`lite/embed.ts`).
  useEffect(() => (embed === null ? undefined : bindChat(embed, controller)), [controller]);
  // This page's address names the chat shown (`?chat=`), so loading the page again (the update's Reload, a reload of
  // the frame) opens it, not the chat the host's address named when it built the panel. A new chat with nothing in it
  // yet is named by none: loading again starts a new chat.
  const named = threadId !== null && (existing || snapshot.entries.length > 0) ? threadId : null;
  useEffect(() => {
    const address = new URL(window.location.href);
    if (address.searchParams.get("chat") === named) return;
    if (named === null) address.searchParams.delete("chat");
    else address.searchParams.set("chat", named);
    window.history.replaceState(window.history.state, "", address);
  }, [named]);
  return (
    <>
      {/* One line in the framing app's muted colour and text size (#2845): the chat's name, New chat, the full app. */}
      <header className="flex h-11 shrink-0 items-center gap-1 px-1 text-t2">
        <h1 className="flex min-w-0 flex-1">
          <Popover
            open={switching}
            onOpenChange={(open) => {
              setSwitching(open);
              if (!open) setQuery("");
            }}
          >
            <PopoverTrigger
              title="Recent chats"
              className="flex min-h-9 max-w-full min-w-0 items-center gap-1 rounded-lg px-2 text-[length:var(--host-text-size,0.875rem)] font-medium text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2 max-sm:min-h-11 tablet:min-h-11"
            >
              <span className="truncate">{title}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-t3" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1rem)] p-0">
              <Command shouldFilter={false}>
                <CommandInput
                  aria-label="Find a chat"
                  placeholder="Find a chat"
                  value={query}
                  onValueChange={setQuery}
                />
                <CommandList>
                  <CommandEmpty>
                    {chats.length === 0
                      ? "No chats in this folder yet."
                      : `No chat's title has "${query.trim()}".`}
                  </CommandEmpty>
                  {listed.length > 0 && (
                    <CommandGroup heading={query.trim() === "" ? "Recent chats" : "Found"}>
                      {listed.map((chat) => (
                        <CommandItem
                          key={chat.id}
                          value={chat.id}
                          onSelect={() => {
                            setSwitching(false);
                            setQuery("");
                            onOpen(chat);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                          {chat.id === threadId && <Check aria-label="Shown now" />}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
        <FullApp threadId={threadId} />
      </header>
      <ChatPane controller={controller} />
    </>
  );
}

/** This page's storage, or null in a frame the browser keeps from it. */
function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The arrow to the full app: it opens the chat where this panel chose last, a browser tab until it chooses. Its menu
 * opens the chat in the desktop app (through its `omp-app://` link, which the system hands to it) or in a browser tab,
 * and keeps that choice for the arrow. In another app's frame the host opens it when it can (`embed.open`): a frame in
 * an editor's webview may open no window or other app's link itself (VS Code's), and an `omp-app://` link the frame
 * followed would leave the panel blank. A host that does not answer leaves it to the view, which opens it as a page does.
 */
function FullApp({ threadId }: { readonly threadId: ThreadId | null }): ReactNode {
  const [place, setPlace] = useState<FullAppPlace>(() => fullAppPlace(pageStorage()));
  const address = (where: FullAppPlace): string =>
    where === "desktop"
      ? desktopAppLink(threadId, window.location.origin)
      : fullAppAddress(threadId);
  const openIn = async (where: FullAppPlace): Promise<void> => {
    keepFullAppPlace(pageStorage(), where);
    setPlace(where);
    // Whole, for the host: the full app's own address is relative to this page.
    const url = new URL(address(where), window.location.href).href;
    if (embed !== null && (await embed.open(url))) return;
    if (where === "desktop") window.location.assign(url);
    else window.open(url, "_blank", "noopener");
  };
  const label = place === "desktop" ? "Open in the desktop app" : "Open in the full app";
  return (
    <div className="flex shrink-0 items-center">
      <a
        href={address(place)}
        {...(place === "browser" ? { target: "_blank", rel: "noopener" } : {})}
        onClick={(event) => {
          // Outside another app's frame the link opens as links do.
          if (embed === null) return;
          event.preventDefault();
          void openIn(place);
        }}
        aria-label={label}
        title={label}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), HEADER_BUTTON)}
      >
        <SquareArrowOutUpRight className={HEADER_ICON} />
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Where the full app opens"
          title="Where the full app opens"
          className="flex h-9 w-5 shrink-0 items-center justify-center rounded-lg text-t3 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2 max-sm:h-11 max-sm:w-7 tablet:h-11 tablet:w-7"
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => void openIn("desktop")}>
            <span className="flex-1">Open in the desktop app</span>
            {place === "desktop" && <Check aria-label="The arrow's choice" />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void openIn("browser")}>
            <span className="flex-1">Open in a browser tab</span>
            {place === "browser" && <Check aria-label="The arrow's choice" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
