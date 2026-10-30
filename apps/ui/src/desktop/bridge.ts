/**
 * The desktop window's commands. Tauri's bridge is on the window's pages only; a browser has none. The window's engine
 * (WebKitGTK) gives a page nothing for a copied picture in its paste event, so the window reads the picture itself
 * (`apps/desktop/src-tauri/src/clipboard.rs`); the window also opens other servers and shows desktop notifications
 * (`commands.rs` there).
 */
export interface Bridge {
  readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** Tauri's bridge when this page is in the desktop window; null in a browser. */
export function desktopBridge(): Bridge | null {
  return (window as Window & { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__ ?? null;
}

/**
 * The picture on the desktop window's clipboard, as a PNG file named for its paste. Null outside the window, or when
 * the clipboard holds no picture; a read the window refuses rejects.
 */
export async function readDesktopClipboardPicture(sequence: number): Promise<File | null> {
  const bridge = desktopBridge();
  if (bridge === null) return null;
  const bytes = await bridge.invoke("read_clipboard_png");
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return null;
  return new File([bytes], `Pasted image ${sequence}.png`, { type: "image/png" });
}

/**
 * The servers the desktop window can open: this computer's, and those on other computers it opened, newest first, by
 * computer name. `current` is the one it shows; null is this computer's.
 */
export interface DesktopServers {
  readonly current: string | null;
  readonly remote: readonly string[];
}

export async function desktopServers(bridge: Bridge): Promise<DesktopServers> {
  const found = (await bridge.invoke("servers")) as { current?: unknown; remote?: unknown } | null;
  const remote = Array.isArray(found?.remote) ? found.remote : [];
  return {
    current: typeof found?.current === "string" ? found.current : null,
    remote: remote.filter((host): host is string => typeof host === "string"),
  };
}

/** Where the desktop window can go: a pasted link, a computer it opened before, or this computer's server. */
export type ServerChoice =
  | { readonly kind: "link"; readonly link: string }
  | { readonly kind: "host"; readonly host: string }
  | { readonly kind: "local" };

/**
 * Moves the desktop window to that server; the window then leaves this page for it. A refusal (a link of another shape,
 * a computer the window never opened) rejects with the window's reason.
 */
export function openDesktopServer(bridge: Bridge, choice: ServerChoice): Promise<unknown> {
  if (choice.kind === "link") return bridge.invoke("connect_server", { link: choice.link });
  if (choice.kind === "host") return bridge.invoke("open_server", { host: choice.host });
  return bridge.invoke("use_this_computer");
}

/** A refusal's words: the window rejects a command with its reason as text. */
export const refusalText = (failure: unknown): string =>
  typeof failure === "string"
    ? failure
    : failure instanceof Error
      ? failure.message
      : String(failure);

/** A desktop notification from the window; nothing in a browser. The window never answers it. */
export function notifyDesktop(summary: string, body: string): void {
  void desktopBridge()
    ?.invoke("notify", { summary, body })
    .catch(() => undefined);
}
