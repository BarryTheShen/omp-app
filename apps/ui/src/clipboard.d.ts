import { type EmbedEndpoint } from "./lite/embed";
/**
 * Puts text in the clipboard: with the browser's clipboard, and where the page's frame may not write it, through the
 * frame's host (the embed protocol's `copy`). VS Code allows clipboard writes only for its own webview pages, so in its
 * panel the extension has VS Code write it. Rejects with the browser's refusal when neither could.
 *
 * A promise of the text (one the server gives) goes to the clipboard before the text is here: WebKit (an iPhone, the
 * desktop window) lets a click write the clipboard only until its first wait.
 */
export declare function writeClipboard(text: string | Promise<string>, host?: Pick<EmbedEndpoint, "copy"> | null): Promise<void>;
