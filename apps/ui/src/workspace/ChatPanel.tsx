import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import {
  createContext,
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
import { ChatController, type ChatTarget } from "../chat/controller";
import { userText } from "../chat/MessageActions";
import { inbox } from "../inbox/inbox";

/** A pane's chat: `chat` names this pane's chat, so a new chat that gets its id keeps its controller. */
export interface ChatPanelParams {
  readonly chat: string;
  readonly target: ChatTarget;
  readonly folder: FolderPath;
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
  /** Opens a new chat in a pane of that tab (an empty tab's New chat). */
  readonly newChat: (api: DockviewApi) => void;
  /** Whether this pane is the one you are in: the focused pane of the tab shown, with the page in front and focused. */
  readonly inView: (paneId: string) => boolean;
}

export const PaneHostContext = createContext<PaneHost | null>(null);

const TITLE_CHARACTERS = 60;

/** One chat pane in dockview: its own controller for as long as the pane shows that chat. */
export function ChatPanel({ params, api }: IDockviewPanelProps<ChatPanelParams>): ReactNode {
  const host = use(PaneHostContext);
  if (host === null) throw new Error("ChatPanel needs the workspace around it.");
  const { client, focus, controllers, composers, onPaneChanged, inView } = host;
  const paneInView = useCallback(() => inView(api.id), [inView, api.id]);
  const onComposer = useCallback(
    (handle: ComposerHandle | null) => {
      if (handle === null) composers.delete(api.id);
      else composers.set(api.id, handle);
    },
    [composers, api.id],
  );
  /** The controller and the chat it was made for: until a new chat's controller is made, the old one is not drawn. */
  const [opened, setOpened] = useState<{
    readonly chat: string;
    readonly controller: ChatController;
  } | null>(null);
  const controller = opened?.chat === params.chat ? opened.controller : null;
  const root = useRef<HTMLDivElement | null>(null);

  // A new controller only when the pane is given another chat; the same chat gaining its id keeps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `params.chat` names the chat; target and folder go with it
  useEffect(() => {
    const next = new ChatController(client, params.target, params.folder, params.chat);
    setOpened({ chat: params.chat, controller: next });
    controllers.set(api.id, next);
    void next.open();
    return () => {
      if (controllers.get(api.id) === next) controllers.delete(api.id);
      void next.dispose();
    };
  }, [client, params.chat]);

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
    <div ref={root} data-chat-pane className="flex h-full min-h-0 flex-col bg-panel">
      {controller !== null && (
        <PaneChat
          key={params.chat}
          controller={controller}
          params={params}
          api={api}
          onPaneChanged={onPaneChanged}
          onComposer={onComposer}
          inView={paneInView}
        />
      )}
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
  const first = snapshot.entries
    .map(userText)
    .find((text): text is string => text !== null && text !== "");
  const title = first === undefined ? "New chat" : first.slice(0, TITLE_CHARACTERS);
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
