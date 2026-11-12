import {
  EMBED_COPY_MAX,
  type EmbedAppBody,
  type EmbedFiles,
  EmbedHostMessage,
  type EmbedSettings,
  type EmbedTool,
  type EmbedToolResult,
  embedMessage,
  type HostContext,
} from "@omp-app/contracts";
import type {
  HostToolCall,
  HostToolDefinition,
  ToolCallAnswer,
} from "@omp-app/contracts/chat-host";
import { useSyncExternalStore } from "react";
import { isLiteView } from "./lite";

/**
 * The lite view's end of the embed protocol (`@omp-app/contracts` `core/embed.ts`): what the page that frames the view
 * said in its `hello`, `settings`, `context` and `tools`, and the messages back to it. Messages count only from the
 * window that frames the view, and only from the origin of its first `hello`; replies go only to that origin.
 */

/** What the framing page said, as the panel shows and uses it. */
export interface EmbedState {
  /** The host's name from its `hello`; null until one came. */
  readonly host: string | null;
  /** The origin of the page that framed this one, as its first `hello` came from it (the browser's word, not the host's); null until one came. */
  readonly origin: string | null;
  readonly settings: EmbedSettings;
  /** What the person is looking at in the host; null when it said nothing or nothing is open. */
  readonly context: HostContext | null;
  /** The person took the context off the next messages: it stays off until the host shows another site. */
  readonly contextLeftOut: boolean;
  readonly tools: readonly EmbedTool[];
  /** The project whose files are on the host's computer, from the first `hello`; null when they are on the server's. */
  readonly files: EmbedFiles | null;
}

const EMPTY: EmbedState = {
  host: null,
  origin: null,
  settings: {},
  context: null,
  contextLeftOut: false,
  tools: [],
  files: null,
};

/**
 * Whether two addresses are of one site: a web address by its origin, any other (a file's path, a note's link) by the whole
 * of it; false when either is missing. A page's own path and query change without the person's doing, its origin does not.
 */
export function sameSite(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    const first = new URL(a);
    const second = new URL(b);
    const web = (url: URL): boolean => url.protocol === "https:" || url.protocol === "http:";
    if (web(first) && web(second)) return first.origin === second.origin;
  } catch {
    // Not web addresses: compared as they are.
  }
  return a === b;
}

/** The part of a window the endpoint uses: so a test gives it a fake one. */
export interface EmbedWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** A tool call the host was handed and has not answered yet. */
interface Waiting {
  readonly resolve: (result: EmbedToolResult) => void;
}

const NO_ANSWER: EmbedToolResult = {
  content: [{ type: "text", text: "The panel's host did not answer this call." }],
  isError: true,
};

/**
 * What a call of the host's tools gets while the person's message here holds them for a reply not seen to start yet: the
 * call is from another reply (`bindChat`).
 */
const NOT_THIS_REPLY =
  "The panel's tools are held for the reply the panel's own message is starting, and this call is from another reply.";

/** How long a panel whose host keeps its key waits for the host's `hello` before it connects without one. */
export const HOST_HELLO_WAIT_MS = 3_000;

/** How long the view waits for the host to say it opened an address, before it opens it itself. */
export const HOST_OPEN_WAIT_MS = 1_000;

/** How long the view waits for the host to say it copied: the host asks its editor, so longer than `open`. */
export const HOST_COPY_WAIT_MS = 2_000;

export class EmbedEndpoint {
  readonly #window: EmbedWindow;
  #state: EmbedState = EMPTY;
  /** The framing page's origin, from its first `hello`: no other origin is heard or told anything. */
  #origin: string | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #waiting = new Map<string, Waiting>();
  /** The addresses the host was asked to open, each with what hears its `opened`. */
  readonly #opening = new Map<string, () => void>();
  /** The copies the host was asked for, each with what hears its `copied`. */
  readonly #copying = new Map<string, (ok: boolean) => void>();
  /** The chat the panel shows (`bindChat`): only its replies are told to the host. */
  #shown: EmbedChat | null = null;
  /** Whether a reply runs in it, as the host was last told (`turn`); null while nothing was told of this chat. */
  #told: boolean | null = null;
  /** The person's message began a reply not seen to start yet (`began`): the chat being idle does not end it. */
  #starting = false;
  /** The key the first `hello` brought (null when it brought none), once it came. */
  readonly #hello = Promise.withResolvers<string | null>();
  /** The owner name of this page's tool registrations: one per page load. */
  readonly owner = `embed-${crypto.randomUUID()}`;
  /**
   * The host keeps this panel's key (`/lite?embed=1`): the browser keeps no cookie of the app in another app's frame, so
   * the page signs in with the key the host's `hello` brings, and hands the host the key it gets when it pairs.
   */
  readonly keepsCredential: boolean;

  constructor(window: EmbedWindow, keepsCredential = false) {
    this.#window = window;
    this.keepsCredential = keepsCredential;
  }

  /** Listens to the framing page, and tells it the view listens; returns what stops it. */
  start(): () => void {
    const onMessage = (event: MessageEvent): void => this.#receive(event);
    this.#window.addEventListener("message", onMessage);
    // Only that it listens, to any origin: the framing page waits for it before its `hello`.
    this.#window.parent.postMessage(embedMessage({ type: "listening" }), "*");
    return () => {
      this.#window.removeEventListener("message", onMessage);
      for (const waiting of this.#waiting.values()) waiting.resolve(NO_ANSWER);
      this.#waiting.clear();
      this.#opening.clear();
      for (const done of [...this.#copying.values()]) done(false);
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EmbedState => this.#state;

  /** Resolves once the host's first `hello` came, or after `waitMs` without one: what the view needs before it chooses its folder. */
  async helloSettled(waitMs = HOST_HELLO_WAIT_MS): Promise<void> {
    await Promise.race([
      this.#hello.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
    ]);
  }

  #set(next: Partial<EmbedState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of [...this.#listeners]) listener();
  }

  #receive(event: MessageEvent): void {
    if (event.source !== this.#window.parent) return;
    const parsed = EmbedHostMessage.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "hello") this.#origin ??= event.origin;
    if (event.origin !== this.#origin) return;
    switch (message.type) {
      case "hello":
        this.#set({
          host: message.host,
          origin: this.#origin,
          settings: { ...this.#state.settings, ...message.settings },
          context: message.context ?? null,
          contextLeftOut: false,
          tools: message.tools ?? [],
          // Read once: the panel's chats run in the folder it chose from the first.
          files: this.#state.host === null ? (message.files ?? null) : this.#state.files,
        });
        this.#hello.resolve(message.credential ?? null);
        return;
      case "settings":
        this.#set({ settings: { ...this.#state.settings, ...message.settings } });
        return;
      case "context": {
        // "Don't send this" holds while the host shows the same site, whatever the page does to its title, its selection
        // or its path meanwhile (a page may change all three by itself, `history.pushState` included); another site, or
        // something with no address, asks again.
        const { context: before, contextLeftOut } = this.#state;
        const stays = contextLeftOut && sameSite(before?.uri, message.context?.uri);
        this.#set({ context: message.context, contextLeftOut: stays });
        return;
      }
      case "tools":
        this.#set({ tools: message.tools });
        return;
      case "tool_result": {
        const waiting = this.#waiting.get(message.callId);
        if (waiting === undefined) return;
        this.#waiting.delete(message.callId);
        waiting.resolve(message.result);
        return;
      }
      case "opened":
        this.#opening.get(message.url)?.();
        return;
      case "copied":
        this.#copying.get(message.id)?.(message.ok);
        return;
    }
  }

  #post(body: EmbedAppBody): void {
    if (this.#origin === null) return;
    this.#window.parent.postMessage(embedMessage(body), this.#origin);
  }

  /** The key the host's `hello` brings: null when it brings none, or when no `hello` comes in `waitMs`. */
  credential(waitMs = HOST_HELLO_WAIT_MS): Promise<string | null> {
    return Promise.race([
      this.#hello.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
    ]);
  }

  /** The key this panel got when it paired, for the host to keep and give back at each load. */
  keepCredential(key: string): void {
    this.#post({ type: "credential", key });
  }

  /** Tells the host which chat shows now, and which of its tools that chat took. */
  announce(chat: string, tools: readonly string[]): void {
    this.#post({ type: "ready", chat, tools });
  }

  /** The chat the panel shows from now on: the host hears of its replies (`working`, `began`). */
  show(chat: EmbedChat): void {
    this.#shown = chat;
    this.#told = null;
    this.#starting = false;
  }

  /** The panel no longer shows the chat: a reply of it holds the host's tools no longer. */
  hide(chat: EmbedChat): void {
    if (this.#shown !== chat) return;
    if (this.#told === true) this.#post({ type: "turn", working: false });
    this.#shown = null;
    this.#told = null;
    this.#starting = false;
  }

  /**
   * Tells the host whether a reply runs in the chat shown (`turn`), when that changed since it was last told, so a host
   * whose tools act on what is in front of the person (a browser's tab) holds them where the reply began. A reply the
   * person's message began (`began`) is not over before it was seen to start.
   */
  working(chat: EmbedChat, running: boolean): void {
    if (chat !== this.#shown || this.#state.host === null) return;
    if (running) this.#starting = false;
    else if (this.#starting) return;
    if (running === this.#told) return;
    this.#told = running;
    this.#post({ type: "turn", working: running });
  }

  /**
   * The person's message in the chat shown, sent while no reply runs there, begins one (`turn` with `sent`): the host
   * holds its tools on what is in front of the person now, for that reply alone. What an earlier reply held goes first.
   */
  began(chat: EmbedChat): void {
    if (chat !== this.#shown || this.#state.host === null) return;
    if (this.#told !== false) this.#post({ type: "turn", working: false });
    this.#told = true;
    this.#starting = true;
    this.#post({ type: "turn", working: true, sent: true });
  }

  /**
   * What the person's message held goes: the message began no reply after all (omp handled it where it stood, refused it,
   * or it joined a reply nobody began here), or the person stopped the reply. The host hears whether a reply runs.
   */
  letGo(chat: EmbedChat): void {
    if (chat !== this.#shown || this.#told !== true) return;
    this.#starting = false;
    this.#told = false;
    this.#post({ type: "turn", working: false });
    this.working(chat, running(chat));
  }

  /** The person's message in the chat shown holds the host's tools for a reply not seen to start yet (`began`). */
  holding(chat: EmbedChat): boolean {
    return chat === this.#shown && this.#starting;
  }

  /** Hands a call of one of the host's tools to the host; resolves with its answer, or an error when the view closes. */
  call(request: HostToolCall): Promise<EmbedToolResult> {
    return new Promise((resolve) => {
      this.#waiting.set(request.id, { resolve });
      this.#post({
        type: "tool_call",
        callId: request.id,
        name: request.params.toolName,
        arguments: request.params.arguments,
      });
    });
  }

  /** omp gave a call up: the host is told, and its late answer is dropped. */
  cancel(callId: string): void {
    if (!this.#waiting.delete(callId)) return;
    this.#post({ type: "tool_cancel", callId });
  }

  /**
   * Asks the host to open an address outside the panel (`open`): true once it says it did, false when no host said hello
   * or none answers in `waitMs`. A frame in an editor's webview may not open windows or another app's links itself.
   */
  open(url: string, waitMs = HOST_OPEN_WAIT_MS): Promise<boolean> {
    if (this.#origin === null) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (opened: boolean): void => {
        clearTimeout(timer);
        if (this.#opening.get(url) === answered) this.#opening.delete(url);
        resolve(opened);
      };
      const answered = (): void => done(true);
      const timer = setTimeout(() => done(false), waitMs);
      this.#opening.set(url, answered);
      this.#post({ type: "open", url });
    });
  }

  /**
   * Asks the host to put `text` in the clipboard (`copy`), for a view whose own clipboard writes are refused (VS Code
   * allows them only for its own webview pages): true once the host says it did; false when no host said hello, the
   * host could not, the text is longer than a copy may be, or no answer comes in `waitMs`.
   */
  copy(text: string, waitMs = HOST_COPY_WAIT_MS): Promise<boolean> {
    if (this.#origin === null || text.length > EMBED_COPY_MAX) return Promise.resolve(false);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.#copying.delete(id);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), waitMs);
      this.#copying.set(id, done);
      this.#post({ type: "copy", id, text });
    });
  }

  /** What goes with the next message: the host's context, unless the person took it off. */
  contextForMessage(): { readonly host: string; readonly context: HostContext } | null {
    const { host, context, contextLeftOut } = this.#state;
    return host === null || context === null || contextLeftOut ? null : { host, context };
  }

  /** The person takes the context off the next messages, until the host says another. */
  leaveContextOut(): void {
    this.#set({ contextLeftOut: true });
  }
}

/**
 * The host's tools as the chat takes them (`set_host_tools`). They are what the panel is for, so omp offers them by
 * name with its own tools (`essential`); left to omp's default, a host's tool is a device the model must look up first
 * (`xd://<name>`).
 */
export function hostToolDefinitions(tools: readonly EmbedTool[]): HostToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    loadMode: "essential",
  }));
}

/** What binding the shown chat needs of its controller (`chat/controller.ts`), which imports this module. */
export interface EmbedChat {
  readonly threadId: string | null;
  readonly store: {
    subscribe(listener: () => void): () => void;
    /**
     * `working`: from omp's `agent_start` to its `agent_end`; `continuing`: omp ended a run that it starts again by
     * itself (a retry, the queued message), so the reply goes on.
     */
    getSnapshot(): { readonly working: boolean; readonly continuing: boolean };
  };
  setHostTools(owner: string, tools: readonly HostToolDefinition[]): Promise<readonly string[]>;
  onHostToolCall(
    call: (request: HostToolCall) => void,
    cancel: (requestId: string) => void,
  ): () => void;
  answerToolCall(id: string, answer: ToolCallAnswer): Promise<void>;
  /** Whether the chat is open for this page on the server, which takes a page's tools only for a chat it holds open. */
  readonly held: boolean;
  /**
   * Hears the chat be open for this page: after its open, after a link that came back (a dropped link took the tools the
   * chat had on the old one), and after a new chat starts in its place.
   */
  onHeld(listener: () => void): () => void;
}

/** Whether a reply runs in the chat: omp works on it, or ended a run of it that it starts again by itself. */
function running(chat: EmbedChat): boolean {
  const { working, continuing } = chat.store.getSnapshot();
  return working || continuing;
}

/**
 * Gives the chat the panel shows the host's tools once the server holds it open for this page, again whenever they
 * change and again each time it is held anew (a dropped link takes them off the chat), hands their calls to the host,
 * and tells the host the chat shows (`ready`). An open chat's id is known before its open answers; tools given then
 * were refused, and never given again. Returns what takes the tools back off the chat, as when the panel shows another.
 */
export function bindChat(endpoint: EmbedEndpoint, chat: EmbedChat): () => void {
  let stopped = false;
  /** The tools the chat took: only their calls go to the host. */
  let given: ReadonlySet<string> = new Set();
  let registered: { readonly tools: readonly EmbedTool[]; readonly chat: string } | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const turn = (): void => {
    if (!stopped) endpoint.working(chat, running(chat));
  };
  const sync = (): void => {
    const threadId = chat.threadId;
    const { host, tools } = endpoint.getSnapshot();
    if (stopped || threadId === null || host === null || !chat.held) return;
    if (registered?.tools === tools && registered.chat === threadId) return;
    registered = { tools, chat: threadId };
    writes = writes.then(async () => {
      const names = await chat
        .setHostTools(endpoint.owner, hostToolDefinitions(tools))
        .catch(() => [] as readonly string[]);
      if (stopped) return;
      given = new Set(names);
      endpoint.announce(threadId, names);
    });
  };
  const stopChat = chat.store.subscribe(() => {
    sync();
    turn();
  });
  const stopEmbed = endpoint.subscribe(() => {
    sync();
    turn();
  });
  const stopCalls = chat.onHostToolCall(
    (request) => {
      if (!given.has(request.params.toolName)) return;
      // omp calls tools only while a reply runs, so a call that comes while the person's message here holds the host's
      // tools for a reply not seen to start yet is from another reply, one this page did not see start: the host is not
      // asked.
      if (endpoint.holding(chat) && !chat.store.getSnapshot().working) {
        void chat
          .answerToolCall(request.id, {
            content: [{ type: "text", text: NOT_THIS_REPLY }],
            isError: true,
          })
          .catch(() => undefined);
        return;
      }
      void endpoint
        .call(request)
        .then((result) => chat.answerToolCall(request.id, result))
        .catch(() => undefined);
    },
    (requestId) => endpoint.cancel(requestId),
  );
  const stopHeld = chat.onHeld(() => {
    registered = null;
    sync();
  });
  endpoint.show(chat);
  sync();
  turn();
  return () => {
    stopped = true;
    stopChat();
    stopEmbed();
    stopCalls();
    stopHeld();
    // The reply of a chat the panel no longer shows holds the host's tools no longer.
    endpoint.hide(chat);
    // A chat kept open behind the panel keeps no tool whose calls nothing here would hear.
    if (registered !== null) {
      void writes.then(() => chat.setHostTools(endpoint.owner, [])).catch(() => undefined);
    }
  };
}

/**
 * This page's endpoint: only in the lite view, inside a frame; null everywhere else. `?embed=1` says the host keeps the
 * panel's key (`keepsCredential`).
 */
export const embed: EmbedEndpoint | null =
  typeof window !== "undefined" && isLiteView() && window.parent !== window
    ? new EmbedEndpoint(window, new URLSearchParams(window.location.search).get("embed") === "1")
    : null;

/** What the framing page said, kept up to date; the empty state outside a frame. */
export function useEmbed(): EmbedState {
  return useSyncExternalStore(embed?.subscribe ?? noSubscribe, embed?.getSnapshot ?? emptySnapshot);
}

const noSubscribe = (): (() => void) => () => undefined;
const emptySnapshot = (): EmbedState => EMPTY;
