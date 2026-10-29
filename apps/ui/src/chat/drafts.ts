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
 */
export class ChatDraft {
  readonly #client: AppClient;
  readonly #threadId: ThreadId;
  readonly #scope: DraftScope;
  #revision: Revision | null = null;
  #pending: string | null = null;
  #timer: number | undefined;

  constructor(client: AppClient, threadId: ThreadId) {
    this.#client = client;
    this.#threadId = threadId;
    this.#scope = { kind: "thread", threadId };
  }

  async load(): Promise<string> {
    const [mine, theirs] = await Promise.all([
      get<string>(this.#threadId, local).catch(() => undefined),
      this.#port()
        .get({ scope: this.#scope })
        .catch(() => null),
    ]);
    this.#revision = theirs?.draft?.revision ?? null;
    return mine ?? theirs?.draft?.text ?? "";
  }

  change(text: string): void {
    void set(this.#threadId, text, local).catch(() => undefined);
    this.#pending = text;
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => void this.#flush(), SERVER_DELAY_MS);
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

  async #flush(): Promise<void> {
    this.#timer = undefined;
    const text = this.#pending;
    this.#pending = null;
    if (text === null) return;
    try {
      await this.#write(text);
    } catch {
      // Another writer moved the app's copy on: take its revision and write once more.
      const current = await this.#port()
        .get({ scope: this.#scope })
        .catch(() => null);
      this.#revision = current?.draft?.revision ?? null;
      await this.#write(text).catch(() => undefined);
    }
  }

  async #write(text: string): Promise<void> {
    if (text === "") {
      if (this.#revision === null) return;
      const cleared = await this.#port().clear({
        scope: this.#scope,
        expectedRevision: this.#revision,
      });
      this.#revision = cleared.revision;
      return;
    }
    const saved = await this.#port().save({
      scope: this.#scope,
      draft: { text, attachments: [], failedSends: [] },
      expectedRevision: this.#revision,
    });
    this.#revision = saved.revision;
  }
}
