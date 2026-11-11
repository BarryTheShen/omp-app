import { type EmbedFiles, type EmbedSettings, type EmbedTool, type EmbedToolResult, type HostContext } from "@omp-app/contracts";
import type { HostToolCall, HostToolDefinition, ToolCallAnswer } from "@omp-app/contracts/chat-host";
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
    /** The project whose files are on the host's computer, from the first `hello`; null when they are on the server's. */
    readonly files: EmbedFiles | null;
}
/** The part of a window the endpoint uses: so a test gives it a fake one. */
export interface EmbedWindow {
    readonly parent: {
        postMessage(message: unknown, targetOrigin: string): void;
    };
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
/** How long a panel whose host keeps its key waits for the host's `hello` before it connects without one. */
export declare const HOST_HELLO_WAIT_MS = 3000;
/** How long the view waits for the host to say it opened an address, before it opens it itself. */
export declare const HOST_OPEN_WAIT_MS = 1000;
/** How long the view waits for the host to say it copied: the host asks its editor, so longer than `open`. */
export declare const HOST_COPY_WAIT_MS = 2000;
export declare class EmbedEndpoint {
    #private;
    /** The owner name of this page's tool registrations: one per page load. */
    readonly owner: string;
    /**
     * The host keeps this panel's key (`/lite?embed=1`): the browser keeps no cookie of the app in another app's frame, so
     * the page signs in with the key the host's `hello` brings, and hands the host the key it gets when it pairs.
     */
    readonly keepsCredential: boolean;
    constructor(window: EmbedWindow, keepsCredential?: boolean);
    /** Listens to the framing page, and tells it the view listens; returns what stops it. */
    start(): () => void;
    readonly subscribe: (listener: () => void) => (() => void);
    readonly getSnapshot: () => EmbedState;
    /** Resolves once the host's first `hello` came, or after `waitMs` without one: what the view needs before it chooses its folder. */
    helloSettled(waitMs?: number): Promise<void>;
    /** The key the host's `hello` brings: null when it brings none, or when no `hello` comes in `waitMs`. */
    credential(waitMs?: number): Promise<string | null>;
    /** The key this panel got when it paired, for the host to keep and give back at each load. */
    keepCredential(key: string): void;
    /** Tells the host which chat shows now, and which of its tools that chat took. */
    announce(chat: string, tools: readonly string[]): void;
    /** Hands a call of one of the host's tools to the host; resolves with its answer, or an error when the view closes. */
    call(request: HostToolCall): Promise<EmbedToolResult>;
    /** omp gave a call up: the host is told, and its late answer is dropped. */
    cancel(callId: string): void;
    /**
     * Asks the host to open an address outside the panel (`open`): true once it says it did, false when no host said hello
     * or none answers in `waitMs`. A frame in an editor's webview may not open windows or another app's links itself.
     */
    open(url: string, waitMs?: number): Promise<boolean>;
    /**
     * Asks the host to put `text` in the clipboard (`copy`), for a view whose own clipboard writes are refused (VS Code
     * allows them only for its own webview pages): true once the host says it did; false when no host said hello, the
     * host could not, the text is longer than a copy may be, or no answer comes in `waitMs`.
     */
    copy(text: string, waitMs?: number): Promise<boolean>;
    /** What goes with the next message: the host's context, unless the person took it off. */
    contextForMessage(): {
        readonly host: string;
        readonly context: HostContext;
    } | null;
    /** The person takes the context off the next messages, until the host says another. */
    leaveContextOut(): void;
}
/**
 * The host's tools as the chat takes them (`set_host_tools`). They are what the panel is for, so omp offers them by
 * name with its own tools (`essential`); left to omp's default, a host's tool is a device the model must look up first
 * (`xd://<name>`).
 */
export declare function hostToolDefinitions(tools: readonly EmbedTool[]): HostToolDefinition[];
/** What binding the shown chat needs of its controller (`chat/controller.ts`), which imports this module. */
export interface EmbedChat {
    readonly threadId: string | null;
    readonly store: {
        subscribe(listener: () => void): () => void;
    };
    setHostTools(owner: string, tools: readonly HostToolDefinition[]): Promise<readonly string[]>;
    onHostToolCall(call: (request: HostToolCall) => void, cancel: (requestId: string) => void): () => void;
    answerToolCall(id: string, answer: ToolCallAnswer): Promise<void>;
    /** Whether the chat is open for this page on the server, which takes a page's tools only for a chat it holds open. */
    readonly held: boolean;
    /**
     * Hears the chat be open for this page: after its open, after a link that came back (a dropped link took the tools the
     * chat had on the old one), and after a new chat starts in its place.
     */
    onHeld(listener: () => void): () => void;
}
/**
 * Gives the chat the panel shows the host's tools once the server holds it open for this page, again whenever they
 * change and again each time it is held anew (a dropped link takes them off the chat), hands their calls to the host,
 * and tells the host the chat shows (`ready`). An open chat's id is known before its open answers; tools given then
 * were refused, and never given again. Returns what takes the tools back off the chat, as when the panel shows another.
 */
export declare function bindChat(endpoint: EmbedEndpoint, chat: EmbedChat): () => void;
/**
 * This page's endpoint: only in the lite view, inside a frame; null everywhere else. `?embed=1` says the host keeps the
 * panel's key (`keepsCredential`).
 */
export declare const embed: EmbedEndpoint | null;
/** What the framing page said, kept up to date; the empty state outside a frame. */
export declare function useEmbed(): EmbedState;
