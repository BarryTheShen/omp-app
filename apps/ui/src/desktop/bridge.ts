/**
 * The desktop window's commands. Tauri's bridge is on the window's pages only; a browser has none. The window's engine
 * (WebKitGTK) gives a page nothing for a copied picture in its paste event, so the window reads the picture itself
 * (`apps/desktop/src-tauri/src/clipboard.rs`).
 */
interface Bridge {
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
