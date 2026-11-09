import * as vscode from "vscode";

/**
 * A change the chat asks to make, shown to the person before it is made: VS Code's diff of the file as the chat read it
 * and as it would be, with ✓ Accept and ✗ Reject in the diff's title bar (`ompApp.acceptChange`, `ompApp.rejectChange`)
 * and in a notification. The call waits for the answer; omp giving the call up closes the diff.
 */
export const REVIEW_SCHEME = "omp-app-review";

interface Pending {
  readonly before: string;
  readonly after: string;
  readonly decide: (accepted: boolean) => void;
}

export class Reviews implements vscode.TextDocumentContentProvider {
  readonly #pending = new Map<string, Pending>();

  /** The texts the diff shows: `omp-app-review:/<id>/before/<name>` and `…/after/<name>`. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, id, side] = uri.path.split("/");
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (pending === undefined) return "";
    return side === "before" ? pending.before : pending.after;
  }

  /** Whether the person accepts the change of `path` from `before` to `after`; false when the call is given up. */
  async ask(path: string, before: string, after: string, signal: AbortSignal): Promise<boolean> {
    const id = crypto.randomUUID();
    const name = path.split("/").at(-1) ?? path;
    const left = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/before/${name}` });
    const right = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/after/${name}` });
    const decided = new Promise<boolean>((resolve) => {
      this.#pending.set(id, { before, after, decide: resolve });
    });
    const onAbort = (): void => this.#decide(id, false);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${path}: omp app's change (✓ accepts, ✗ rejects)`,
        { preview: false },
      );
      void vscode.window
        .showInformationMessage(`omp app wants to change ${path}.`, "Accept", "Reject")
        .then((choice) => {
          if (choice !== undefined) this.#decide(id, choice === "Accept");
        });
      return await decided;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#pending.delete(id);
      await closeTabsOf(id);
    }
  }

  /** The change the active diff shows is accepted (`ompApp.acceptChange`) or rejected (`ompApp.rejectChange`). */
  decideActive(accepted: boolean): void {
    const uri = vscode.window.activeTextEditor?.document.uri ?? activeDiffUri();
    if (uri?.scheme !== REVIEW_SCHEME) return;
    const [, id] = uri.path.split("/");
    if (id !== undefined) this.#decide(id, accepted);
  }

  #decide(id: string, accepted: boolean): void {
    this.#pending.get(id)?.decide(accepted);
  }

  /** Every waiting change is rejected (the panel or the extension closes). */
  rejectAll(): void {
    for (const pending of this.#pending.values()) pending.decide(false);
  }
}

/** The modified side of the active diff tab, when the active tab is a diff. */
function activeDiffUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
}

/** Closes the diff of one change. */
async function closeTabsOf(id: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => {
      const input = tab.input;
      return (
        input instanceof vscode.TabInputTextDiff &&
        input.modified.scheme === REVIEW_SCHEME &&
        input.modified.path.startsWith(`/${id}/`)
      );
    }),
  );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
}
