import { type EmbedEndpoint, embed } from "./lite/embed";

/**
 * Puts text in the clipboard: with the browser's clipboard, and where the page's frame may not write it, through the
 * frame's host (the embed protocol's `copy`). VS Code allows clipboard writes only for its own webview pages, so in its
 * panel the extension has VS Code write it. Rejects with the browser's refusal when neither could.
 *
 * A promise of the text (one the server gives) goes to the clipboard before the text is here: WebKit (an iPhone, the
 * desktop window) lets a click write the clipboard only until its first wait.
 */
export async function writeClipboard(
  text: string | Promise<string>,
  host: Pick<EmbedEndpoint, "copy"> | null = embed,
): Promise<void> {
  if (
    typeof text !== "string" &&
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard?.write !== undefined
  ) {
    const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
    // The text's own failure is reported below, where the text is awaited.
    blob.catch(() => undefined);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Not taken as a promise, or refused: written below once the text is here.
    }
  }
  const value = await text;
  try {
    await navigator.clipboard.writeText(value);
  } catch (refused) {
    if (host === null || !(await host.copy(value))) throw refused;
  }
}
