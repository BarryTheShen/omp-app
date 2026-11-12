/**
 * `@omp-app/embed`: what a host (a browser extension's panel, an editor's webview, a notes app, a web page) uses to show
 * omp app's chat in a panel and talk to it, over the embed protocol (`@omp-app/contracts` `core/embed.ts`). It makes the
 * frame, says hello when the panel listens (again after each load of it), sends settings, what is open and tools, answers
 * each call of a tool with its handler, and keeps the panel's key where the host keeps it.
 *
 * The page that uses it must be one the app lets frame it (`OMP_APP_FRAME_ANCESTORS`; a browser extension's or VS
 * Code's panel always may), and the panel pairs once, as any device. Only types come from the contracts: the library
 * has no other code.
 */
import type {
  EmbedAppMessage,
  EmbedFiles,
  EmbedHostMessage,
  EmbedSettings,
  EmbedTool,
  EmbedToolResult,
  HostContext,
} from "@omp-app/contracts";

export type { EmbedFiles, EmbedSettings, EmbedTool, EmbedToolResult, HostContext };

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
 * A `get` that fails or takes longer than `KEY_WAIT_MS` counts as no key; a `set` that fails is the host's to tell.
 */
export interface KeyKeeper {
  get(): string | null | Promise<string | null>;
  set(key: string): void | Promise<void>;
}

/**
 * How long the hello waits for the host's key: the panel connects without one after 3 s, so a key read held up (a
 * keyring's prompt) must not hold the hello, which carries the host's tools, settings and what is open.
 */
export const KEY_WAIT_MS = 2_500;

/** How long the panel's page has to say it listens before `onNoAnswer`: it does in about a second. */
export const NO_ANSWER_MS = 10_000;

export interface PanelOptions {
  /** omp app's address: an HTTPS one (`https://omp.example.com`), or a loopback one on this computer (`http://127.0.0.1:4317`). */
  readonly app: string;
  /** The element the panel's frame goes into; the frame fills it. */
  readonly into: HTMLElement;
  /** The host's name, shown beside what goes with each message: lowercase letters, digits and dashes, 32 at most. */
  readonly host: string;
  readonly settings?: EmbedSettings;
  /** What the person is looking at: it goes with each message sent from the panel, which shows it. */
  readonly context?: HostContext | null;
  readonly tools?: readonly HostTool[];
  /** Keeps the panel's key in the host's storage; leave it out when the frame keeps the app's cookie (a page on the app's own site). */
  readonly keys?: KeyKeeper;
  /** The address's parameters, for the first paint (`theme`, `greeting`, `placeholder`, the look's colours). */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * The project's files are on the host's computer (an editor's open folder): its name, and an id the host derives from
   * its folder (hex). The panel's chats then run in the server's folder for that project, with omp's own file and shell
   * tools left out; the host's `tools` reach the files.
   */
  readonly files?: EmbedFiles;
  /** The chat to open, as `onReady` named it before (a host that keeps one chat per tab gives it back); none: a new one. */
  readonly chat?: string;
  /** The panel shows a chat: its id and the host's tools it took; again whenever it shows another. */
  readonly onReady?: (ready: { readonly chat: string; readonly tools: readonly string[] }) => void;
  /**
   * A reply runs in the chat the panel shows (`working` true), including while omp runs it again by itself, or none does
   * any more (false). `sent`: the person's message in the panel (Retry too), sent while no reply ran, began it; false for
   * a reply begun any other way (a message sent into a running reply sends nothing). A host whose tools act on what is in
   * front of the person, as a browser's tab, keeps them on what was in front when the person's message began the reply,
   * and on nothing otherwise, so a reply never acts on what the person turned to while it ran.
   */
  readonly onTurn?: (working: boolean, sent: boolean) => void;
  /**
   * The panel's page did not say it listens within `NO_ANSWER_MS` of the panel opening: the app is not at the address,
   * cannot be reached from here, or does not let this host frame it. Called at
   * most once; the frame stays, in case the page still comes.
   */
  readonly onNoAnswer?: () => void;
  /**
   * Opens an address the panel asks to open outside it: the full app (the app's own address) or the desktop app's
   * `omp-app://` link; no other is passed on. A host whose frame may open no window or other app's link itself, as an
   * editor's webview, opens it here and returns true; the panel then knows it is open. Left out, or false, the panel
   * opens it itself.
   */
  readonly onOpen?: (url: string) => boolean | Promise<boolean>;
  /**
   * Puts text the panel copies in the clipboard, for a host whose frame may not let the panel write it (an editor's
   * webview: VS Code allows clipboard writes only for its own webview pages, not the app framed in one); returns true
   * once it did. Called only right after the person's click or key (`copyAllowed`). Left out, the panel's copies use
   * the browser's clipboard alone.
   */
  readonly onCopy?: (text: string) => boolean | Promise<boolean>;
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

/** Whether the panel may have an address opened outside it: the app's own pages, or the desktop app's link. */
export function opensOutside(url: unknown, appOrigin: string): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "omp-app:" || parsed.origin === appOrigin;
  } catch {
    return false;
  }
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

/** The most characters one `copy` carries: the protocol's `EMBED_COPY_MAX`, kept here as the library takes no code from the contracts. */
export const COPY_MAX = 2_000_000;

/** The browser's transient activation, as `navigator.userActivation` gives it. */
export interface Activation {
  readonly isActive: boolean;
}

/**
 * Whether the panel may have text copied now: the person's click or key in it still counts (the browser's transient
 * activation, which a click in the panel's frame gives this page too), so the panel cannot fill the clipboard unasked.
 * A browser that does not say (`null`) lets it, as its own clipboard does.
 */
export function copyAllowed(
  text: unknown,
  activation: Activation | null = (
    globalThis.navigator as { userActivation?: Activation } | undefined
  )?.userActivation ?? null,
): text is string {
  if (typeof text !== "string" || text.length > COPY_MAX) return false;
  return activation === null || activation.isActive;
}

/** The key the host keeps: null when it keeps none, its read fails, or the read takes longer than `KEY_WAIT_MS`. */
export async function keptKey(keys: KeyKeeper | undefined): Promise<string | null> {
  if (keys === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => keys.get()),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), KEY_WAIT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * omp app's address from what the person typed, or why it is not one: an `https` address (where the app is served for
 * other computers), or a loopback `http` address with its port (the app on this computer). Only the origin is kept.
 */
export function appAddressOf(
  typed: string,
): { readonly address: string } | { readonly problem: string } {
  const text = typed.trim();
  if (text === "") return { problem: "Type omp app's address." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `"${text}" is not an address. It starts with https://.` };
  }
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port !== "";
  if (url.protocol !== "https:" && !loopback)
    return {
      problem:
        "omp app's address starts with https://, or is http://127.0.0.1 with its port when the app runs on this computer.",
    };
  return { address: url.origin };
}

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
  const silent = setTimeout(() => options.onNoAnswer?.(), NO_ANSWER_MS);

  const frame = document.createElement("iframe");
  frame.title = options.title ?? "omp app";
  frame.src = address.href;
  // Writes only: the app copies (Copy buttons) but never reads the clipboard; pasting goes by the paste event, which
  // needs no permission.
  frame.allow = "clipboard-write";
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
    const credential = await keptKey(options.keys);
    post({
      type: "hello",
      host: options.host,
      ...(settings === undefined ? {} : { settings }),
      ...(context === undefined ? {} : { context }),
      tools: described(tools),
      ...(credential === null ? {} : { credential }),
      ...(options.files === undefined ? {} : { files: options.files }),
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
        clearTimeout(silent);
        greeted = false;
        stopAll();
        void hello();
        return;
      case "ready":
        options.onReady?.({ chat: message.chat, tools: message.tools });
        return;
      case "turn":
        if (typeof message.working === "boolean")
          options.onTurn?.(message.working, message.sent === true);
        return;
      case "tool_call":
        void answer(message.callId, message.name, message.arguments);
        return;
      case "tool_cancel":
        running.get(message.callId)?.abort();
        running.delete(message.callId);
        return;
      case "credential":
        // A key the host could not keep is the host's to tell: the panel asks to pair again at its next load.
        void Promise.resolve()
          .then(() => options.keys?.set(message.key))
          .catch(() => undefined);
        return;
      case "open": {
        // Only the app's own pages and the desktop app's link, and only when the host opens them.
        const opener = options.onOpen;
        const url = message.url;
        if (opener === undefined || !opensOutside(url, origin)) return;
        void Promise.resolve()
          .then(() => opener(url))
          .then((opened) => {
            if (opened) post({ type: "opened", url });
          })
          .catch(() => undefined);
        return;
      }
      case "copy": {
        const { id, text } = message;
        if (typeof id !== "string") return;
        const copier = options.onCopy;
        if (copier === undefined || !copyAllowed(text)) {
          post({ type: "copied", id, ok: false });
          return;
        }
        void Promise.resolve()
          .then(() => copier(text))
          .then(
            (copied) => post({ type: "copied", id, ok: copied === true }),
            () => post({ type: "copied", id, ok: false }),
          );
        return;
      }
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
      clearTimeout(silent);
      window.removeEventListener("message", listen);
      stopAll();
      frame.remove();
    },
  };
}
