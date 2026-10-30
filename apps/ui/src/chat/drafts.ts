import type { AppClient } from "@omp-app/client";
import { type DraftScope, DraftStore, type Revision, type ThreadId } from "@omp-app/contracts";
import { createStore, get, set } from "idb-keyval";

const local = createStore("omp-app-ui", "drafts");
/** How long typing pauses before the app's copy is written. */
const SERVER_DELAY_MS = 800;

/**
 * A chat's unsent text, kept so typed text is never lost (H2): every change goes to this browser's IndexedDB at once,
 * and to the app's draft store a moment later, where another browser finds it. This browser's copy wins when both
 * exist; an empty box is kept as an empty text, so text sent or deleted here does not come back from the app's copy.
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

  /** The draft of a saved chat, under its id; or, with a pane key, of a new chat that has no id yet. */
  constructor(client: AppClient, home: ThreadId | { readonly paneChat: string }) {
    this.#client = client;
    if (typeof home === "string") {
      this.#loadKey = home;
      this.#scope = { kind: "thread", threadId: home };
    } else {
      this.#loadKey = `new-chat:${home.paneChat}`;
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
    if (this.#text === null) return;
    void set(threadId, this.#text, local).catch(() => undefined);
    this.#queue(this.#text);
  }

  /** Writes the app's copy now; the chat is being closed. */
  dispose(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    void this.#flush();
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
    try {
      await this.#write(scope, text);
    } catch {
      // Another writer moved the app's copy on: take its revision and write once more.
      const current = await this.#port()
        .get({ scope })
        .catch(() => null);
      this.#revision = current?.draft?.revision ?? null;
      await this.#write(scope, text).catch(() => undefined);
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
