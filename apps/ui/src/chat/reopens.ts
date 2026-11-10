/** How many times a pane opens a chat afresh by itself after the link came back, before only Try again does. */
export const LINK_REOPENS = 3;

/**
 * A pane's opens made by itself once the link to the server was back, counted per chat: a link that comes back but
 * fails each open again stops after `LINK_REOPENS`, and Try again by hand starts the count over.
 */
export class LinkReopens {
  #key = "";
  #count = 0;

  /** One more open by itself for the chat named `key`: true while fewer than `LINK_REOPENS` were made for it. */
  take(key: string): boolean {
    if (key !== this.#key) {
      this.#key = key;
      this.#count = 0;
    }
    if (this.#count >= LINK_REOPENS) return false;
    this.#count += 1;
    return true;
  }

  /** Try again was clicked: the opens by itself count again from none. */
  reset(): void {
    this.#count = 0;
  }
}
