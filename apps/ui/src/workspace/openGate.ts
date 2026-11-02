/**
 * When a pane opens its chat (#2768). On a desktop every pane opens at once, as the window shows them all. A phone shows
 * one pane, yet every tab and pane it keeps comes back with the page: each would open its chat (a new chat starting an
 * omp of its own) over the phone's one connection. There a pane opens only once it is the pane in front.
 */
export class OpenGate {
  #everyPane: boolean;
  readonly #allowed = new Set<string>();
  readonly #waiting = new Map<string, () => void>();

  constructor(everyPane: boolean) {
    this.#everyPane = everyPane;
  }

  /** Every pane opens (a desktop), or only the panes let through (a phone); a change to every pane opens the waiting. */
  setEveryPane(everyPane: boolean): void {
    this.#everyPane = everyPane;
    if (!everyPane) return;
    for (const [paneId, open] of this.#waiting) {
      this.#waiting.delete(paneId);
      open();
    }
  }

  /** The pane came to the front: its chat opens now, and later ones in it at once. */
  allow(paneId: string): void {
    this.#allowed.add(paneId);
    const open = this.#waiting.get(paneId);
    if (open === undefined) return;
    this.#waiting.delete(paneId);
    open();
  }

  /** Settles when the pane may open its chat. */
  wait(paneId: string): Promise<void> {
    if (this.#everyPane || this.#allowed.has(paneId)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiting.set(paneId, resolve);
    });
  }

  /** The pane closed: nothing waits for it any more. */
  forget(paneId: string): void {
    this.#waiting.delete(paneId);
    this.#allowed.delete(paneId);
  }
}
