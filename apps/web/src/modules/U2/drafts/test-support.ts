import { AppFailure, type Draft, type DraftInput, type DraftScope } from "@omp-app/contracts";
import type { DraftStoreAdapter } from "./drafts";

/** The store key the test double keeps a scope's draft under. */
function scopeKey(scope: DraftScope): string {
  return scope.kind === "thread" ? `thread:${scope.threadId}` : `folder:${scope.folder}`;
}

/**
 * An in-memory draft store with the server's rules: a save names the revision it replaces, a clear of a
 * scope with no draft answers "not cleared", and a revision that no longer matches is a conflict.
 */
export class ScopedDraftStore implements DraftStoreAdapter {
  readonly saved = new Map<string, Draft>();
  readonly clears: string[] = [];
  private revisions = 0;

  /** The text stored for a scope, or undefined when the scope holds no draft. */
  text(scope: DraftScope): string | undefined {
    return this.saved.get(scopeKey(scope))?.text;
  }

  async get(args: { readonly scope: DraftScope }): Promise<{ readonly draft: Draft | null }> {
    return { draft: this.saved.get(scopeKey(args.scope)) ?? null };
  }

  async save(args: {
    readonly scope: DraftScope;
    readonly draft: DraftInput;
    readonly expectedRevision: string | null;
  }): Promise<Draft> {
    const key = scopeKey(args.scope);
    const existing = this.saved.get(key);
    if ((existing?.revision ?? null) !== args.expectedRevision) {
      throw new AppFailure({
        code: "conflict",
        message: "The draft changed in another tab",
        retryable: true,
      });
    }
    this.revisions += 1;
    const draft: Draft = {
      scope: args.scope,
      text: args.draft.text,
      attachments: [...args.draft.attachments],
      failedSends: [...args.draft.failedSends],
      revision: `revision-${this.revisions}`,
      updatedAt: new Date(0).toISOString(),
    };
    this.saved.set(key, draft);
    return draft;
  }

  async clear(args: {
    readonly scope: DraftScope;
    readonly expectedRevision: string | null;
  }): Promise<{ readonly cleared: boolean; readonly revision: string | null }> {
    const key = scopeKey(args.scope);
    const existing = this.saved.get(key);
    if (existing === undefined) return { cleared: false, revision: null };
    if (existing.revision !== args.expectedRevision) {
      throw new AppFailure({
        code: "conflict",
        message: "The draft changed in another tab",
        retryable: true,
      });
    }
    this.clears.push(key);
    this.saved.delete(key);
    return { cleared: true, revision: null };
  }
}
