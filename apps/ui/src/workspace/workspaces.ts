import type { WorkspaceTab } from "./tabs";

/** The workspaces as the chat list shows them: each one, the one shown, their labels, the one whose name is typed. */
export interface WorkspacesView {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
  /** Each workspace's label: its name, or its first chat's title. */
  readonly labels: ReadonlyMap<string, string>;
  readonly renaming: string | null;
}

/** What the list does to the workspaces: what the strip on top did. */
export interface WorkspacesActions {
  readonly activate: (id: string) => void;
  readonly close: (id: string) => void;
  readonly rename: (id: string, title: string) => void;
  readonly renaming: (id: string | null) => void;
  /** A workspace dragged onto another's place. */
  readonly move: (id: string, to: number) => void;
  /** Pins a workspace (never closed for not being used, a preview kept) or unpins it. */
  readonly pin: (id: string, pinned: boolean) => void;
  readonly add: () => void;
}

/**
 * The workspaces, from the workspace (which keeps them) to the chat list (which shows them while it is open, as Zen's
 * sidebar shows a browser's spaces): the view to draw and the actions to take, without the app redrawing for either.
 */
export class WorkspacesStore {
  #view: WorkspacesView | null = null;
  #actions: WorkspacesActions | null = null;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The workspaces as they are now; null until the workspace has said. */
  readonly getSnapshot = (): WorkspacesView | null => this.#view;

  /** What the list's rows do; null until the workspace has said. */
  get actions(): WorkspacesActions | null {
    return this.#actions;
  }

  /** The workspace says what it has and what can be done to it. */
  set(view: WorkspacesView, actions: WorkspacesActions): void {
    this.#actions = actions;
    if (this.#view !== null && sameView(this.#view, view)) return;
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }
}

function sameView(a: WorkspacesView, b: WorkspacesView): boolean {
  if (a.active !== b.active || a.renaming !== b.renaming || a.tabs.length !== b.tabs.length)
    return false;
  return a.tabs.every((tab, index) => {
    const other = b.tabs[index];
    return (
      other?.id === tab.id &&
      a.labels.get(tab.id) === b.labels.get(other.id) &&
      tab.preview === other.preview &&
      tab.pinned === other.pinned
    );
  });
}
