import type { AppClient } from "@omp-app/client";
import {
  type DraftChanged,
  type DraftScope,
  DraftStore,
  type Revision,
  type ThreadId,
} from "@omp-app/contracts";
import { createStore, del, get, set } from "idb-keyval";
import { follow } from "../follow";

const local = createStore("omp-app-ui", "drafts");
/** Where this browser keeps a new chat's text: under its pane's key. */
const newChatKey = (paneChat: string): string => `new-chat:${paneChat}`;
/** How long typing pauses before the app's copy is written. */
const SERVER_DELAY_MS = 800;

/**
 * A chat's unsent text, kept so typed text is never lost (H2): every change goes to this browser's IndexedDB at once,
 * and to the app's draft store a moment later, where another browser finds it. This browser's copy wins when both
 * exist; an empty box is kept as an empty text, so text sent or deleted here does not come back from the app's copy.
 * While a window is open it follows the app's copy too (`follow`), so a text another window or browser saved, sent or
 * cleared shows in its box while nothing of its own waits to be written.
 *
 * A new chat has no id until omp opens it, so its text is kept under its pane's key (`forNewChat`) and, once the chat
 * has an id, under that id too (`keepFor`): a reload that opens the same pane finds it by the pane's key, and one that
 * opens the saved chat finds it by the id.
 */
export class ChatDraft {
  readonly #client: AppClient;
  /** Where this browser keeps the text: the pane's key for a new chat, and each id the chat has had. */
  readonly #keys: string[];
  /** Where `load` reads from: the first key. */
  readonly #loadKey: string;
  /** The app's copy `load` reads: a saved chat's own, none for a new chat. */
  readonly #loadScope: DraftScope | null;
  /** The app's copy changes are written to; null for a new chat that has no id yet. */
  #scope: DraftScope | null;
  #revision: Revision | null = null;
  #pending: string | null = null;
  /** The text this draft holds: the last typed, or what `load` found. Null until one of them. */
  #text: string | null = null;
  #timer: number | undefined;
  /** A write to the app's copy is under way: what the app says meanwhile may be that write. */
  #writing = false;
  /** Who hears texts other writers saved (`follow`), and the stop of the subscription for the scope followed now. */
  #follower: ((before: string, next: string) => void) | null = null;
  #stopFollowing: (() => void) | null = null;

  /** The draft of a saved chat, under its id; or, with a pane key, of a new chat that has no id yet. */
  constructor(client: AppClient, home: ThreadId | { readonly paneChat: string }) {
    this.#client = client;
    if (typeof home === "string") {
      this.#loadKey = home;
      this.#scope = { kind: "thread", threadId: home };
    } else {
      this.#loadKey = newChatKey(home.paneChat);
      this.#scope = null;
    }
    this.#keys = [this.#loadKey];
    this.#loadScope = this.#scope;
  }

  /** The draft of a new chat: kept under its pane's key, which the saved layout keeps across a reload. */
  static forNewChat(client: AppClient, paneChat: string): ChatDraft {
    return new ChatDraft(client, { paneChat });
  }

  async load(): Promise<string> {
    const loadScope = this.#loadScope;
    const [mine, theirs] = await Promise.all([
      get<string>(this.#loadKey, local).catch(() => undefined),
      loadScope === null
        ? null
        : this.#port()
            .get({ scope: loadScope })
            .catch(() => null),
    ]);
    if (loadScope !== null) this.#revision = theirs?.draft?.revision ?? null;
    const kept = mine ?? theirs?.draft?.text ?? "";
    this.#text ??= kept;
    return kept;
  }

  change(text: string): void {
    this.#text = text;
    for (const key of this.#keys) void set(key, text, local).catch(() => undefined);
    this.#queue(text);
  }

  /**
   * The chat has this id now (omp opened it, or moved it to its real one): from here every change is kept under it
   * too, and the text held now is written there. Called again with another id, it adds that one.
   */
  keepFor(threadId: ThreadId): void {
    if (!this.#keys.includes(threadId)) this.#keys.push(threadId);
    this.#scope = { kind: "thread", threadId };
    this.#revision = null;
    this.#followScope();
    if (this.#text === null) return;
    void set(threadId, this.#text, local).catch(() => undefined);
    this.#queue(this.#text);
  }

  /**
   * Follows the app's copy of this chat's draft while a window shows it: a text another window or browser saved, sent or
   * cleared becomes this draft's while nothing of this window's own waits to be written (what is typed here wins, as its
   * write would), and `listener` hears the text held before and the new one, so the box takes it only while it still
   * shows the old one. Call it once `load` has answered; a new chat follows once `keepFor` gives it an id. Returns the
   * stop.
   */
  follow(listener: (before: string, next: string) => void): () => void {
    this.#follower = listener;
    this.#followScope();
    return () => {
      if (this.#follower !== listener) return;
      this.#follower = null;
      this.#stopFollowing?.();
      this.#stopFollowing = null;
    };
  }

  /** Writes the app's copy now and stops following it; the chat is being closed. */
  dispose(): void {
    this.#follower = null;
    this.#stopFollowing?.();
    this.#stopFollowing = null;
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    void this.#flush();
  }

  #followScope(): void {
    this.#stopFollowing?.();
    this.#stopFollowing = null;
    const scope = this.#scope;
    if (this.#follower === null || scope === null || scope.kind !== "thread") return;
    const started = this.#client.subscribe(DraftStore, "changed", {
      scope: `thread:${scope.threadId}`,
    });
    this.#stopFollowing = follow(started, (changed) => this.#theirs(changed));
    // A change made between `load`'s read and the subscription's start is read once more.
    void started
      .then(() => this.#port().get({ scope }))
      .then((current) => this.#theirs({ scope, draft: current.draft }))
      .catch(() => undefined);
  }

  /** The app's copy as another writer left it; see `follow`. */
  #theirs(changed: DraftChanged): void {
    const scope = this.#scope;
    if (this.#follower === null || scope?.kind !== "thread") return;
    if (changed.scope.kind !== "thread" || changed.scope.threadId !== scope.threadId) return;
    const revision = changed.draft?.revision ?? null;
    // This window's own write, or a text it holds already.
    if (revision === this.#revision) return;
    // Something typed here waits to be written, or is being written: it wins, as its write will.
    if (this.#pending !== null || this.#writing || this.#timer !== undefined) return;
    const before = this.#text ?? "";
    const next = changed.draft?.text ?? "";
    this.#revision = revision;
    this.#text = next;
    for (const key of this.#keys) void set(key, next, local).catch(() => undefined);
    if (next !== before) this.#follower(before, next);
  }

  #port() {
    return this.#client.port(DraftStore);
  }

  #queue(text: string): void {
    this.#pending = text;
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => void this.#flush(), SERVER_DELAY_MS);
  }

  async #flush(): Promise<void> {
    this.#timer = undefined;
    const text = this.#pending;
    const scope = this.#scope;
    // A new chat without an id has no app copy to write; `keepFor` queues its text again once it has one.
    if (text === null || scope === null) return;
    this.#pending = null;
    this.#writing = true;
    try {
      await this.#write(scope, text);
    } catch {
      // Another writer moved the app's copy on: take its revision and write once more.
      const current = await this.#port()
        .get({ scope })
        .catch(() => null);
      this.#revision = current?.draft?.revision ?? null;
      await this.#write(scope, text).catch(() => undefined);
    } finally {
      this.#writing = false;
    }
  }

  async #write(scope: DraftScope, text: string): Promise<void> {
    if (text === "") {
      if (this.#revision === null) return;
      const cleared = await this.#port().clear({
        scope,
        expectedRevision: this.#revision,
      });
      this.#revision = cleared.revision;
      return;
    }
    const saved = await this.#port().save({
      scope,
      draft: { text, attachments: [], failedSends: [] },
      expectedRevision: this.#revision,
    });
    this.#revision = saved.revision;
  }
}

/**
 * A new chat's pane was closed: its text, kept under the pane's key only so a reload that reopens the pane finds it, goes
 * too. A chat's copies under its id stay, as they do for every closed chat. A pane that became a saved chat still has its
 * old key, and a missing key is not an error.
 */
export function forgetNewChatDraft(paneChat: string): Promise<void> {
  return del(newChatKey(paneChat), local).catch(() => undefined);
}
