/**
 * The picture on the desktop window's clipboard. The window's engine (WebKitGTK) gives a page nothing for a copied
 * picture in its paste event, so the window reads the picture itself, through its clipboard command (see
 * apps/desktop/src-tauri/src/clipboard.rs). A browser has no such command, and nothing is read there.
 */

/** The command the desktop window offers: the clipboard's picture as PNG bytes, empty when there is none. */
const READ_CLIPBOARD_PICTURE = "read_clipboard_png";

/** Tauri's bridge to the window's commands. It is on the desktop window's pages only. */
interface DesktopBridge {
  readonly invoke: (command: string) => Promise<unknown>;
}

/**
 * The picture on the desktop window's clipboard, as a PNG file named for its paste. Null when this page is not in the
 * desktop window, or the clipboard holds no picture. A read the window refuses rejects.
 */
export async function readDesktopClipboardPicture(sequence: number): Promise<File | null> {
  const bridge = (window as Window & { __TAURI_INTERNALS__?: DesktopBridge }).__TAURI_INTERNALS__;
  if (bridge === undefined) return null;
  const bytes = await bridge.invoke(READ_CLIPBOARD_PICTURE);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return null;
  return new File([bytes], pastedPictureName(sequence, "image/png"), { type: "image/png" });
}

/** The name of a pasted picture: its number and its file extension, so two pictures never share a name. */
export function pastedPictureName(sequence: number, type: string): string {
  const subtype = type.slice("image/".length).split("+", 1)[0];
  return `Pasted image ${sequence}.${subtype || "png"}`;
}
