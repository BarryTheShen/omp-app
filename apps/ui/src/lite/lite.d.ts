import { type EmbedSettings, type ThreadId } from "@omp-app/contracts";
/** Whether this page is the lite view: one chat and its message box, for another app's side panel. */
export declare const isLiteView: () => boolean;
/** The mode the page that frames the lite view asks for (`?theme=light` or `?theme=dark`); null follows the system. */
export declare function liteThemeMode(): "light" | "dark" | null;
/**
 * The chat the lite view opens first (`?chat=<id>`): a host that keeps one chat per tab or document gives back the one
 * it showed there (the embed protocol's `ready` names it). Null, or a value that is no chat's id, opens a new chat.
 */
export declare function liteChat(search: string): ThreadId | null;
/** The full app, showing the chat (`#chat=<id>`, `takeLinkChat`), or as it was left for a chat with no id yet. */
export declare const fullAppAddress: (threadId: ThreadId | null) => string;
/**
 * The desktop app's link for the chat (`omp-app://chat/<id>?server=<origin>`), or for the server alone while the chat
 * has no id yet: the system hands it to the desktop app, which shows the chat in its window on that server, and only
 * for a server it opens already (`apps/desktop/src-tauri/src/chat_link.rs`).
 */
export declare function desktopAppLink(threadId: ThreadId | null, origin: string): string;
/** Where the lite view's arrow opens the full app: a browser tab, or the desktop app. */
export type FullAppPlace = "browser" | "desktop";
/** The place this panel chose last; a browser tab until it chooses. */
export declare function fullAppPlace(storage: Pick<Storage, "getItem"> | null): FullAppPlace;
/** Keeps the place chosen, for the panel's next loads; a storage the browser refuses keeps nothing. */
export declare function keepFullAppPlace(storage: Pick<Storage, "setItem"> | null, place: FullAppPlace): void;
/** What the framing app may set for its assistant (#2845); null keeps the app's own. */
export interface LiteChoices {
    /** The empty chat's greeting (`?greeting=`), in place of "What are we working on?". */
    readonly greeting: string | null;
    /** Rows under the greeting that send their text (`?suggest=a|b|c`); none when none are given. */
    readonly suggestions: readonly string[];
    /** The empty message box's text (`?placeholder=`), in place of "Message omp". */
    readonly placeholder: string | null;
}
/**
 * The framing app's greeting, suggestions and placeholder from the address, read once at load. A text is trimmed; one
 * that is empty or longer than its limit is ignored (a greeting 120 characters, a placeholder 80, a suggestion 60), and
 * at most the first 5 different suggestions are kept.
 */
export declare function liteChoices(search: string): LiteChoices;
/** The address's choices with the framing page's settings over them (`lite/embed.ts`); an empty text clears one. */
export declare function withEmbedChoices(base: LiteChoices, settings: EmbedSettings): LiteChoices;
/**
 * The app that frames the lite view (`?host=siyuan`): each message sent from it carries the name, so that app's
 * extensions add what it has open only to messages sent from its side panel, and their lines for it show only here.
 * Null without one, or for one that is not an app's name (lowercase letters, digits and dashes, 32 at most).
 */
export declare function liteHost(search: string): string | null;
/** This page's app: the lite view's `host`, read once at load; null in the full app, and outside a browser. */
export declare const pageHost: string | null;
