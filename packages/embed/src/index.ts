/**
 * `@omp-app/embed`: what a host (a browser extension's panel, an editor's webview, a notes app, a web page) uses to show
 * omp app's chat in a panel and talk to it, over the embed protocol (`@omp-app/contracts` `core/embed.ts`). It makes the
 * frame, says hello when the panel listens (again after each load of it), sends settings, what is open and tools, answers
 * each call of a tool with its handler, and keeps the panel's key where the host keeps it.
 *
 * The page that uses it must be one the app lets frame it (Settings → App → Integrations, or `OMP_APP_FRAME_ANCESTORS`),
 * and the panel pairs once, as any device. Only types come from the contracts: the library has no other code.
 */
import type {
  EmbedAppMessage,
  EmbedHostMessage,
  EmbedSettings,
  EmbedTool,
  EmbedToolResult,
  HostContext,
} from "@omp-app/contracts";

export type { EmbedSettings, EmbedTool, EmbedToolResult, HostContext };

/** One of the host's tools, with what answers its calls. */
export interface HostTool extends EmbedTool {
  /**
   * Answers one call. Text is the answer; an error thrown goes back as the call's error, its message as the text.
   * `signal` aborts when omp gives the call up, or when the panel loads again or closes.
   */
  readonly run: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => EmbedToolResult | string | Promise<EmbedToolResult | string>;
}

/**
 * Where the host keeps the panel's key: an extension's or an editor's own storage, out of any page's reach. A frame in
 * another app keeps no cookie of omp app, so the panel signs in with this key; without it, it would pair at every load.
 */
export interface KeyKeeper {
  get(): string | null | Promise<string | null>;
  set(key: string): void | Promise<void>;
}

export interface PanelOptions {
  /** omp app's address: its tailnet address over HTTPS (`https://<computer>.<tailnet>.ts.net`), or a loopback one. */
  readonly app: string;
  /** The element the panel's frame goes into; the frame fills it. */
  readonly into: HTMLElement;
  /** The host's name, shown beside what goes with each message: lowercase letters, digits and dashes, 32 at most. */
  readonly host: string;
  readonly settings?: EmbedSettings;
  /** What the person is looking at: it goes with each message sent from the panel, which shows it. */
  readonly context?: HostContext | null;
  readonly tools?: readonly HostTool[];
  /** Keeps the panel's key in the host's storage; leave it out when the frame keeps the app's cookie (a tailnet page). */
  readonly keys?: KeyKeeper;
  /** The address's parameters, for the first paint (`theme`, `greeting`, `placeholder`, the look's colours). */
  readonly params?: Readonly<Record<string, string>>;
  /** The chat to open, as `onReady` named it before (a host that keeps one chat per tab gives it back); none: a new one. */
  readonly chat?: string;
  /** The panel shows a chat: its id and the host's tools it took; again whenever it shows another. */
  readonly onReady?: (ready: { readonly chat: string; readonly tools: readonly string[] }) => void;
  /** The frame's name for screen readers. */
  readonly title?: string;
}

export interface Panel {
  readonly frame: HTMLIFrameElement;
  setSettings(settings: EmbedSettings): void;
  /** What is open now; null when nothing is. */
  setContext(context: HostContext | null): void;
  /** The tools from now on, in place of those before. */
  setTools(tools: readonly HostTool[]): void;
  /** Takes the frame away and stops listening; calls still running are aborted. */
  close(): void;
}

const HOST_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A message from the panel: the protocol's envelope, and a type. */
function isAppMessage(data: unknown): data is EmbedAppMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as { omp?: unknown; v?: unknown; type?: unknown };
  return message.omp === "embed" && message.v === 1 && typeof message.type === "string";
}

function checkTools(tools: readonly HostTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name))
      throw new Error(
        `A tool's name is lowercase letters, digits and underscores, starting with a letter: "${tool.name}".`,
      );
    if (names.has(tool.name)) throw new Error(`Two tools are named "${tool.name}".`);
    names.add(tool.name);
  }
}

/** A host message without its envelope, each type with its own fields. */
type HostBody = EmbedHostMessage extends infer Message
  ? Message extends EmbedHostMessage
    ? Omit<Message, "omp" | "v">
    : never
  : never;

/** What the protocol sends of a tool: everything but its handler. */
const described = (tools: readonly HostTool[]): EmbedTool[] =>
  tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

function asResult(answer: EmbedToolResult | string): EmbedToolResult {
  return typeof answer === "string" ? { content: [{ type: "text", text: answer }] } : answer;
}

const failed = (text: string): EmbedToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Shows omp app's chat in a frame inside `into`, and talks to it. */
export function openPanel(options: PanelOptions): Panel {
  if (!HOST_NAME.test(options.host))
    throw new Error(
      `The host's name is lowercase letters, digits and dashes, starting with a letter: "${options.host}".`,
    );
  checkTools(options.tools ?? []);
  const origin = new URL(options.app).origin;
  const address = new URL("/lite", origin);
  for (const [name, value] of Object.entries(options.params ?? {}))
    address.searchParams.set(name, value);
  if (options.keys !== undefined) address.searchParams.set("embed", "1");
  if (options.chat !== undefined) address.searchParams.set("chat", options.chat);

  let settings = options.settings;
  let context = options.context;
  let tools: readonly HostTool[] = options.tools ?? [];
  /** The panel's page now loaded has had its hello: messages may go to it. */
  let greeted = false;
  const running = new Map<string, AbortController>();

  const frame = document.createElement("iframe");
  frame.title = options.title ?? "omp app";
  frame.src = address.href;
  frame.allow = "clipboard-read; clipboard-write";
  frame.style.cssText = "display:block;width:100%;height:100%;border:0";

  const post = (message: HostBody): void => {
    frame.contentWindow?.postMessage({ omp: "embed", v: 1, ...message }, origin);
  };

  const stopAll = (): void => {
    for (const controller of running.values()) controller.abort();
    running.clear();
  };

  const answer = async (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) {
      post({
        type: "tool_result",
        callId,
        result: failed(`This host has no tool named "${name}".`),
      });
      return;
    }
    const controller = new AbortController();
    running.set(callId, controller);
    let result: EmbedToolResult;
    try {
      result = asResult(await tool.run(args, controller.signal));
    } catch (error) {
      result = failed(error instanceof Error ? error.message : String(error));
    }
    // A call given up, or one of a page that loaded again, gets no answer: nothing waits for it.
    if (running.get(callId) !== controller || controller.signal.aborted) return;
    running.delete(callId);
    post({ type: "tool_result", callId, result });
  };

  const hello = async (): Promise<void> => {
    const credential = (await options.keys?.get()) ?? null;
    post({
      type: "hello",
      host: options.host,
      ...(settings === undefined ? {} : { settings }),
      ...(context === undefined ? {} : { context }),
      tools: described(tools),
      ...(credential === null ? {} : { credential }),
    });
    greeted = true;
  };

  const listen = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const message: unknown = event.data;
    if (!isAppMessage(message)) return;
    switch (message.type) {
      case "listening":
        // The panel's page loaded (the first time, or again, after pairing): what ran for the page before is over.
        greeted = false;
        stopAll();
        void hello();
        return;
      case "ready":
        options.onReady?.({ chat: message.chat, tools: message.tools });
        return;
      case "tool_call":
        void answer(message.callId, message.name, message.arguments);
        return;
      case "tool_cancel":
        running.get(message.callId)?.abort();
        running.delete(message.callId);
        return;
      case "credential":
        void options.keys?.set(message.key);
        return;
    }
  };

  window.addEventListener("message", listen);
  options.into.append(frame);

  return {
    frame,
    setSettings(next) {
      settings = { ...settings, ...next };
      if (greeted) post({ type: "settings", settings: next });
    },
    setContext(next) {
      context = next;
      if (greeted) post({ type: "context", context: next });
    },
    setTools(next) {
      checkTools(next);
      tools = next;
      if (greeted) post({ type: "tools", tools: described(next) });
    },
    close() {
      window.removeEventListener("message", listen);
      stopAll();
      frame.remove();
    },
  };
}
