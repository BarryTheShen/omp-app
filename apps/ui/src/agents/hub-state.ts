/** The Agent Hub of one pane: closed (null), or open on a subagent (`selected`), or on the list alone (null). */
export type AgentHubView = { readonly selected: string | null } | null;

/**
 * Whether a pane's Agent Hub is open and on which subagent. It lives on the pane's chat controller, so Alt+A, the
 * agents pill, a task card and the side panel's Agents list all open the same hub.
 */
export class AgentHubState {
  #view: AgentHubView = null;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AgentHubView => this.#view;

  /** Opens the hub on a subagent, or on the list alone. */
  open(selected: string | null = null): void {
    if (this.#view?.selected === selected) return;
    this.#view = { selected };
    this.#publish();
  }

  close(): void {
    if (this.#view === null) return;
    this.#view = null;
    this.#publish();
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
