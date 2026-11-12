/** What a page tool says when no reply the person began from the sidebar holds a tab. */
export const NO_TAB_HELD =
  "This reply did not begin with a message sent from this sidebar, so it may act on no tab. A message sent from the sidebar acts on the tab in front when it is sent.";

/** A reply runs that the person did not begin from this panel, or began with no tab in front: it acts on no tab. */
const NONE = -1;

/**
 * Which tab the chat's page tools act on (`TabScope.bound`): only while a reply the person began from this panel runs,
 * the tab that was in front when they sent its message. The reply keeps it though another tab comes to the front, and a
 * message sent into it moves nothing. A reply begun any other way (on another device, from a task, Resume, the app
 * itself) acts on no tab, and between replies the tools act on none.
 */
export class Follower {
  #front: number | null = null;
  /** null: no reply runs, as the panel was told (`turn`); NONE: one runs that holds no tab; else the tab it holds. */
  #held: number | null = null;

  /** The tab the running reply holds; refused when no reply the person began here runs. */
  bound(): number {
    if (this.#held === null || this.#held === NONE) throw new Error(NO_TAB_HELD);
    return this.#held;
  }

  /** Another tab came to the front of the window, or none is in front. */
  front(tabId: number | null): void {
    this.#front = tabId;
  }

  /**
   * A reply began or none runs any more (`turn` from the panel). `sent`: the person's message in this panel began it, so
   * it holds the tab in front now. A reply begun any other way holds no tab, and a running reply keeps what it holds. A
   * held tab that closes stays held: the reply's later calls fail on it rather than act on another.
   */
  turn(working: boolean, sent = false): void {
    if (!working) {
      this.#held = null;
      return;
    }
    if (this.#held !== null) return;
    this.#held = sent ? (this.#front ?? NONE) : NONE;
  }
}
