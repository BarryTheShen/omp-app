/**
 * Active processing time for one chat: the sum of the windows in which omp was working, from when a turn
 * starts being processed until it stops. Idle time between turns never counts, so the total says how long
 * omp has worked, not how long the chat has been open. The window edges are the moments the app received
 * the runtime's state change, so the total is approximate.
 */
export class ActiveTimeMeter {
  #totalMs = 0;
  #windowStart: number | null = null;

  /** Records whether omp is working at `now` (epoch ms). A state that repeats changes nothing. */
  observe(working: boolean, now: number): void {
    if (working) {
      this.#windowStart ??= now;
      return;
    }
    if (this.#windowStart !== null) {
      this.#totalMs += Math.max(0, now - this.#windowStart);
      this.#windowStart = null;
    }
  }

  /** The total so far, including the window that is still open at `now`. */
  activeMs(now: number): number {
    const open = this.#windowStart === null ? 0 : Math.max(0, now - this.#windowStart);
    return this.#totalMs + open;
  }
}
