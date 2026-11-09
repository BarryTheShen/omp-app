import {
  type EmbedAppBody,
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
  readonly settings: EmbedSettings;
  /** What the person is looking at in the host; null when it said nothing or nothing is open. */
  readonly context: HostContext | null;
  /** The person took the context off the next messages: it stays off until the host says another. */
  readonly contextLeftOut: boolean;
  readonly tools: readonly EmbedTool[];
}

const EMPTY: EmbedState = {
  host: null,
  settings: {},
  context: null,
  contextLeftOut: false,
  tools: [],
};

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

export class EmbedEndpoint {
  readonly #window: EmbedWindow;
  #state: EmbedState = EMPTY;
  /** The framing page's origin, from its first `hello`: no other origin is heard or told anything. */
  #origin: string | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #waiting = new Map<string, Waiting>();
  /** The owner name of this page's tool registrations: one per page load. */
  readonly owner = `embed-${crypto.randomUUID()}`;

  constructor(window: EmbedWindow) {
    this.#window = window;
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
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EmbedState => this.#state;

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
          settings: { ...this.#state.settings, ...message.settings },
          context: message.context ?? null,
          contextLeftOut: false,
          tools: message.tools ?? [],
        });
        return;
      case "settings":
        this.#set({ settings: { ...this.#state.settings, ...message.settings } });
        return;
      case "context":
        this.#set({ context: message.context, contextLeftOut: false });
        return;
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
    }
  }

  #post(body: EmbedAppBody): void {
    if (this.#origin === null) return;
    this.#window.parent.postMessage(embedMessage(body), this.#origin);
  }

  /** Tells the host which chat shows now, and which of its tools that chat took. */
  announce(chat: string, tools: readonly string[]): void {
    this.#post({ type: "ready", chat, tools });
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

/** The host's tools as the chat takes them (`set_host_tools`). */
export function hostToolDefinitions(tools: readonly EmbedTool[]): HostToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** What binding the shown chat needs of its controller (`chat/controller.ts`), which imports this module. */
export interface EmbedChat {
  readonly threadId: string | null;
  readonly store: { subscribe(listener: () => void): () => void };
  setHostTools(owner: string, tools: readonly HostToolDefinition[]): Promise<readonly string[]>;
  onHostToolCall(
    call: (request: HostToolCall) => void,
    cancel: (requestId: string) => void,
  ): () => void;
  answerToolCall(id: string, answer: ToolCallAnswer): Promise<void>;
}

/**
 * Gives the chat the panel shows the host's tools, once it is open and again whenever they change, hands their calls to
 * the host, and tells the host the chat shows (`ready`). Returns what takes the tools back off the chat, as when the
 * panel shows another one.
 */
export function bindChat(endpoint: EmbedEndpoint, chat: EmbedChat): () => void {
  let stopped = false;
  /** The tools the chat took: only their calls go to the host. */
  let given: ReadonlySet<string> = new Set();
  let registered: { readonly tools: readonly EmbedTool[]; readonly chat: string } | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const sync = (): void => {
    const threadId = chat.threadId;
    const { host, tools } = endpoint.getSnapshot();
    if (stopped || threadId === null || host === null) return;
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
  const stopChat = chat.store.subscribe(sync);
  const stopEmbed = endpoint.subscribe(sync);
  const stopCalls = chat.onHostToolCall(
    (request) => {
      if (!given.has(request.params.toolName)) return;
      void endpoint
        .call(request)
        .then((result) => chat.answerToolCall(request.id, result))
        .catch(() => undefined);
    },
    (requestId) => endpoint.cancel(requestId),
  );
  sync();
  return () => {
    stopped = true;
    stopChat();
    stopEmbed();
    stopCalls();
    // A chat kept open behind the panel keeps no tool whose calls nothing here would hear.
    if (registered !== null) {
      void writes.then(() => chat.setHostTools(endpoint.owner, [])).catch(() => undefined);
    }
  };
}

/** This page's endpoint: only in the lite view, inside a frame; null everywhere else. */
export const embed: EmbedEndpoint | null =
  typeof window !== "undefined" && isLiteView() && window.parent !== window
    ? new EmbedEndpoint(window)
    : null;

/** What the framing page said, kept up to date; the empty state outside a frame. */
export function useEmbed(): EmbedState {
  return useSyncExternalStore(embed?.subscribe ?? noSubscribe, embed?.getSnapshot ?? emptySnapshot);
}

const noSubscribe = (): (() => void) => () => undefined;
const emptySnapshot = (): EmbedState => EMPTY;
