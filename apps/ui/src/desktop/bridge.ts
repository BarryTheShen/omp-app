/**
 * The desktop window's commands. Tauri's bridge is on the window's pages only; a browser has none. The window's engine
 * (WebKitGTK) gives a page nothing for a copied picture in its paste event, and a file a file manager copied may come as
 * its path alone, so the window reads them itself (`apps/desktop/src-tauri/src/clipboard.rs`); the window also opens
 * other servers and shows desktop notifications (`commands.rs` there).
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

/** A file a file manager copied, as the desktop window lists it: its name and its size in bytes. */
export interface CopiedFile {
  readonly name: string;
  readonly size: number;
}

/** A picture's type by its name's extension, for the types omp's models read; empty for any other file. */
const PICTURE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const isCopiedFile = (entry: unknown): entry is CopiedFile =>
  typeof entry === "object" &&
  entry !== null &&
  typeof (entry as CopiedFile).name === "string" &&
  typeof (entry as CopiedFile).size === "number";

/**
 * The files a file manager copied, read by the desktop window (#2833), as files the message box takes (a picture with
 * its type, so it goes to the model as one picked does). A file larger than `maxBytes` is not read: it comes back in
 * `tooLarge`. Null outside the window. A desktop app older than this rejects with the words for it.
 */
export async function readDesktopClipboardFiles(maxBytes: number): Promise<{
  readonly files: readonly File[];
  readonly tooLarge: readonly CopiedFile[];
} | null> {
  const bridge = desktopBridge();
  if (bridge === null) return null;
  let listed: unknown;
  try {
    listed = await bridge.invoke("list_clipboard_files");
  } catch (failure) {
    const reason = refusalText(failure);
    // A desktop app that predates the command refuses it as one its capabilities do not list (Tauri's ACL).
    if (/not allowed by ACL|not found/i.test(reason))
      throw new Error(
        "This desktop app is older than pasting copied files: install the latest one.",
      );
    throw new Error(reason);
  }
  const files: File[] = [];
  const tooLarge: CopiedFile[] = [];
  for (const [index, entry] of (Array.isArray(listed) ? listed : []).entries()) {
    if (!isCopiedFile(entry)) continue;
    if (entry.size > maxBytes) {
      tooLarge.push(entry);
      continue;
    }
    const bytes = await bridge.invoke("read_clipboard_file", { index });
    if (!(bytes instanceof ArrayBuffer)) continue;
    const type = PICTURE_TYPES[entry.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "";
    files.push(new File([bytes], entry.name, { type }));
  }
  return { files, tooLarge };
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

/**
 * Opens another desktop window, on the server this window shows, at the next free window of the app. A refusal (the
 * server does not answer, or a desktop app older than New window) rejects with the words for it.
 */
export async function openDesktopWindow(bridge: Bridge): Promise<unknown> {
  try {
    return await bridge.invoke("new_window");
  } catch (failure) {
    const reason = refusalText(failure);
    // A desktop app that predates the command refuses it as one its capabilities do not list (Tauri's ACL).
    if (/not allowed by ACL|not found/i.test(reason))
      throw new Error("This desktop app is older than New window: install 0.2.1319 or newer.");
    throw new Error(`New window: ${reason}`);
  }
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
