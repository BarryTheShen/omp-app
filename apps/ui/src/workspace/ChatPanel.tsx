import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import type {
  DockviewApi,
  IDockviewGroupPanel,
  IDockviewPanel,
  IDockviewPanelProps,
} from "dockview-react";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChatPane } from "../chat/ChatPane";
import type { ComposerHandle } from "../chat/Composer";
import { useChatTitle } from "../chat/chatTitle";
import { ChatController, type ChatTarget } from "../chat/controller";
import { LinkReopens } from "../chat/reopens";
import { inbox } from "../inbox/inbox";
import { chatCache } from "./chatCache";
import type { OpenGate } from "./openGate";
import { PaneModeOutline } from "./paneMode";

/** A pane's chat: `chat` names this pane's chat, so a new chat that gets its id keeps its controller. */
export interface ChatPanelParams {
  readonly chat: string;
  readonly target: ChatTarget;
  readonly folder: FolderPath;
}

/** What takes a click itself: a click there leaves the caret where that puts it. */
const TAKES_CLICKS =
  "a, button, input, textarea, select, summary, label, [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='tab'], [role='checkbox'], [role='switch'], [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [contenteditable='true'], [tabindex]:not([tabindex='-1'])";

/**
 * A click that puts the caret in a pane's message box, as omp's terminal types into its editor, so the pane's keys
 * reach the pane chosen (Ctrl+P, Shift+Tab): a click of the main mouse button that nothing took for itself. Never a
 * tap, which would bring a phone's keyboard up over the chat.
 */
export function mouseClickTakesCaret(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if ((event.nativeEvent as PointerEvent).pointerType === "touch") return false;
  return !window.matchMedia("(pointer: coarse)").matches;
}

/**
 * A click on a pane (its transcript, its empty space) where nothing in the pane takes it, and that selected no text. A
 * click in a menu or popover opened from the pane (the model menu's star, a thinking level) reaches the pane's handler
 * through React from outside the pane's elements: it is no click on the pane, and leaves the caret where it is.
 */
function paneClickTakesCaret(event: MouseEvent<HTMLElement>): boolean {
  if (!mouseClickTakesCaret(event) || !(event.target instanceof Element)) return false;
  if (!event.currentTarget.contains(event.target)) return false;
  const taker = event.target.closest(TAKES_CLICKS);
  if (taker !== null && event.currentTarget.contains(taker)) return false;
  return window.getSelection()?.isCollapsed !== false;
}

/** How many frames a pane asked for may take to be drawn and shown (about half a second). */
const FOCUS_FRAMES = 30;

/**
 * The caret for panes. A pane asked for before its message box can take the caret (a pane just made: not drawn yet, or
 * not yet placed and shown by dockview) takes it once it can, if nothing else was asked for meanwhile. A pane whose
 * chat was just replaced waits for its new box: the old one is still drawn, and goes with the caret in it.
 */
export class PaneFocus {
  readonly #boxes = new Map<string, () => boolean>();
  #pending: string | null = null;
  #frames = 0;
  #scheduled = false;

  /** A pane's message box; `focusBox` puts the caret in it and says whether it is there now. */
  register(id: string, focusBox: () => boolean): () => void {
    this.#boxes.set(id, focusBox);
    if (this.#pending === id) this.#try();
    return () => {
      if (this.#boxes.get(id) === focusBox) this.#boxes.delete(id);
    };
  }

  request(id: string, replaced = false): void {
    this.#pending = id;
    this.#frames = 0;
    if (replaced) this.#boxes.delete(id);
    this.#try();
  }

  #try(): void {
    const id = this.#pending;
    if (id === null) return;
    if (this.#boxes.get(id)?.() === true) {
      this.#pending = null;
      return;
    }
    if (this.#scheduled) return;
    if (++this.#frames > FOCUS_FRAMES) {
      this.#pending = null;
      return;
    }
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      this.#try();
    });
  }
}

/** What every pane needs from the workspace around it. */
export interface PaneHost {
  readonly client: AppClient;
  readonly focus: PaneFocus;
  /** The open chats' controllers by pane, for the workspace's view of what waits for you. */
  readonly controllers: Map<string, ChatController>;
  /** The panes' message boxes, for the palette's files and commands. */
  readonly composers: Map<string, ComposerHandle>;
  /** Tells the workspace a pane's chat, title or state changed. */
  readonly onPaneChanged: () => void;
  /** Opens a new chat in a workspace: in that blank window (its New chat), else in the focused one or beside. */
  readonly newChat: (api: DockviewApi, group?: IDockviewGroupPanel) => void;
  /** Closes a window the person asked to close (its ×), and its workspace with its only window (#2831). */
  readonly closePane: (api: DockviewApi, panel: IDockviewPanel) => void;
  /** Whether this pane is the one you are in: the focused pane of the tab shown, with the page in front and focused. */
  readonly inView: (paneId: string) => boolean;
  /** When a pane opens its chat: at once on a desktop, once it is in front on a phone (#2768). */
  readonly openGate: OpenGate;
  /** Opens a chat as a link does: where a window shows it, that one comes to the front (the dashboard's links). */
  readonly openChat: (target: ChatTarget, how: "front" | "behind" | "beside") => void;
}

export const PaneHostContext = createContext<PaneHost | null>(null);

/**
 * One chat pane in dockview: the chat's controller for as long as the pane shows that chat. A chat the page kept open
 * (`chatCache`) is taken from there and shown as it is now; the pane gives its chat back when it moves on.
 */
export function ChatPanel({ params, api }: IDockviewPanelProps<ChatPanelParams>): ReactNode {
  const host = use(PaneHostContext);
  if (host === null) throw new Error("ChatPanel needs the workspace around it.");
  const { client, focus, controllers, composers, onPaneChanged, inView, openGate } = host;
  const paneInView = useCallback(() => inView(api.id), [inView, api.id]);
  const onComposer = useCallback(
    (handle: ComposerHandle | null) => {
      if (handle === null) composers.delete(api.id);
      else composers.set(api.id, handle);
    },
    [composers, api.id],
  );
  /** Each fresh open of this pane's chat (Try again, or the link back): a new controller for the same chat. */
  const [attempt, setAttempt] = useState(0);
  const [reopens] = useState(() => new LinkReopens());
  /** The controller and the chat it was made for: until a new chat's controller is made, the old one is not drawn. */
  const [opened, setOpened] = useState<{
    readonly chat: string;
    readonly attempt: number;
    readonly controller: ChatController;
  } | null>(null);
  const controller =
    opened?.chat === params.chat && opened.attempt === attempt ? opened.controller : null;
  const root = useRef<HTMLDivElement | null>(null);

  // A controller only when the pane is given another chat, or opens its chat afresh; the same chat gaining its id keeps
  // it. A new controller opens its chat once the gate lets the pane through: at once on a desktop, when the pane is in
  // front on a phone. A chat that could not open asks for a fresh open (Try again, or the link back) or a new chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `params.chat` names the chat; target and folder go with it
  useEffect(() => {
    const kept =
      params.target.kind === "existing"
        ? chatCache.take(client, params.target.threadId)
        : undefined;
    const next = kept ?? new ChatController(client, params.target, params.folder, params.chat);
    setOpened({ chat: params.chat, attempt, controller: next });
    controllers.set(api.id, next);
    let current = true;
    if (kept === undefined)
      void openGate.wait(api.id).then(() => {
        if (current) void next.open();
      });
    const stopAsks = next.onPaneAsk((ask) => {
      if (ask.kind === "new-chat") {
        api.updateParameters({
          chat: crypto.randomUUID(),
          target: { kind: "new", folder: params.folder },
          folder: params.folder,
        } satisfies ChatPanelParams);
        api.setTitle("New chat");
        return;
      }
      if (ask.by === "person") reopens.reset();
      else if (!reopens.take(params.chat)) return;
      setAttempt((count) => count + 1);
    });
    return () => {
      current = false;
      stopAsks();
      if (controllers.get(api.id) === next) controllers.delete(api.id);
      // A chat that never opened is empty: the cache closes it rather than keep it.
      chatCache.keep(client, next);
    };
  }, [client, params.chat, attempt]);

  // A pane that closes leaves the gate.
  useEffect(() => () => openGate.forget(api.id), [openGate, api.id]);

  // Once the pane's message box is drawn, the keys that move between panes can put the caret in it.
  useEffect(() => {
    if (controller === null) return;
    return focus.register(api.id, () => {
      const box = root.current?.querySelector<HTMLTextAreaElement>("textarea");
      box?.focus();
      return box !== null && box !== undefined && document.activeElement === box;
    });
  }, [controller, api.id, focus]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click only puts the caret in the message box, as Tab does
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard reaches the message box with Tab
    <div
      ref={root}
      data-chat-pane
      className="relative flex h-full min-h-0 flex-col bg-panel"
      onClick={(event) => {
        if (paneClickTakesCaret(event)) focus.request(api.id);
      }}
    >
      {controller !== null && (
        <PaneChat
          key={`${params.chat}:${attempt}`}
          controller={controller}
          params={params}
          api={api}
          onPaneChanged={onPaneChanged}
          onComposer={onComposer}
          inView={paneInView}
        />
      )}
      <PaneModeOutline api={api} />
    </div>
  );
}

function PaneChat({
  controller,
  params,
  api,
  onPaneChanged,
  onComposer,
  inView,
}: {
  readonly controller: ChatController;
  readonly params: ChatPanelParams;
  readonly api: IDockviewPanelProps<ChatPanelParams>["api"];
  readonly onPaneChanged: () => void;
  readonly onComposer: (handle: ComposerHandle | null) => void;
  /** Whether this pane is the one you are in now. */
  readonly inView: () => boolean;
}): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  // The name the chat list shows once the chat is saved, else its first message.
  const title = useChatTitle(controller, snapshot.entries);
  const waiting = snapshot.requests.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a question or approval arriving or ending is news for the sidebar
  useEffect(() => {
    if (api.title !== title) api.setTitle(title);
    onPaneChanged();
  }, [api, title, waiting, onPaneChanged]);

  // A new chat that has a message is kept as that chat, so the saved layout opens it again.
  const threadId = controller.threadId;
  const sessionFile = controller.sessionFile;
  const saved = params.target.kind === "new" && snapshot.entries.length > 0;
  useEffect(() => {
    if (!saved || threadId === null || sessionFile === null) return;
    api.updateParameters({ ...params, target: { kind: "existing", threadId, sessionFile } });
    onPaneChanged();
  }, [api, params, saved, threadId, sessionFile, onPaneChanged]);

  // The inbox: this chat waits for you for as long as it does, and what its runs settle with while you are in another
  // pane, tab or window is kept there until you look.
  const titleNow = useRef(title);
  useEffect(() => {
    titleNow.current = title;
  }, [title]);
  useEffect(() => {
    if (threadId === null || sessionFile === null) return;
    const chat = { threadId, sessionFile, title };
    inbox.setWaiting(chat, waiting);
    return () => inbox.setWaiting(chat, false);
  }, [threadId, sessionFile, title, waiting]);
  useEffect(
    () =>
      controller.onAttention((attention) => {
        const id = controller.threadId;
        const file = controller.sessionFile;
        if (id === null || file === null || inView()) return;
        inbox.add({ threadId: id, sessionFile: file, title: titleNow.current }, attention);
      }),
    [controller, inView],
  );

  return <ChatPane key={params.chat} controller={controller} onComposer={onComposer} />;
}
