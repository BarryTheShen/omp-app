import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  AppFailure,
  type AttachmentRef,
  type Draft,
  type DraftChanged,
  type DraftClearArgs,
  type DraftClearResult,
  type DraftGetArgs,
  DraftInput,
  type DraftInput as DraftInputValue,
  DraftScope,
  type DraftScope as DraftScopeValue,
  type FailedSend,
  type Revision,
} from "@omp-app/contracts";
import {
  compareAndSwapFile,
  type FileSnapshot,
  type FileWatcher,
  hashContent,
  readFileSnapshot,
  resolveAppDataDir,
  watchFile,
} from "../fs";

const DRAFT_VERSION = 1;
const MAX_FAILED_SENDS = 20;
const DRAFTS_DIRECTORY = "drafts";
const THREADS_DIRECTORY = "threads";
const FOLDERS_DIRECTORY = "folders";

export interface DraftStoreOptions {
  /** App-owned data root; defaults to OMP_APP_DATA_DIR or ~/.omp/app. */
  readonly appDataDir?: string;
  /** Environment used when resolving the default app data root. */
  readonly env?: Record<string, string | undefined>;
  /** Home directory used when resolving the default app data root. */
  readonly homeDir?: string;
  /** Base directory for a relative OMP_APP_DATA_DIR value. */
  readonly cwd?: string;
  /** Receives malformed-file and watcher failures without allowing them to escape. */
  readonly onError?: (error: AppFailure) => void;
  /** Defaults to the fs watcher debounce. */
  readonly watchDebounceMs?: number;
}

export type DraftChangeListener = (change: DraftChanged) => void | Promise<void>;

type DraftScopeRequest =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "folder"; readonly folder: string };
type DraftGetRequest = Omit<DraftGetArgs, "scope"> & { readonly scope: DraftScopeRequest };
type DraftSaveRequest = {
  readonly scope: DraftScopeRequest;
  readonly draft: DraftInputValue;
  readonly expectedRevision: Revision | null;
};
type DraftClearRequest = Omit<DraftClearArgs, "scope"> & { readonly scope: DraftScopeRequest };

type StoredDraftValue = {
  readonly kind: "draft";
  readonly scope: DraftScopeValue;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly failedSends: readonly FailedSend[];
  readonly updatedAt: string;
};

type StoredTombstoneValue = {
  readonly kind: "cleared";
  readonly scope: DraftScopeValue;
  readonly clearedAt: string;
};

type StoredValue = StoredDraftValue | StoredTombstoneValue;

type DraftState =
  | { readonly kind: "missing"; readonly snapshot: FileSnapshot; readonly value: null }
  | {
      readonly kind: "cleared";
      readonly snapshot: FileSnapshot;
      readonly value: StoredTombstoneValue;
    }
  | { readonly kind: "draft"; readonly snapshot: FileSnapshot; readonly value: StoredDraftValue };

interface ScopeWatcher {
  readonly scope: DraftScopeValue;
  readonly path: string;
  readonly watcher: FileWatcher;
  readonly listeners: Set<number>;
}

interface Subscription {
  readonly id: number;
  readonly scopeKey: string;
  readonly listener: DraftChangeListener;
}

/**
 * A save or clear lost a compare-and-swap race (another tab or window saved first). In-process callers
 * get `currentRevision`; over the wire only the AppError travels, so the browser re-reads the draft
 * with `get` and merges (the AppError's `omp` field is reserved for omp's own errors).
 */
export class DraftConflict extends AppFailure {
  readonly currentRevision: Revision | null;

  constructor(currentRevision: Revision | null) {
    super({
      code: "conflict",
      message: "The draft changed in another window; reload it and merge.",
      retryable: true,
    });
    this.currentRevision = currentRevision;
  }
}

function appFailure(
  code: "invalid_args" | "not_found" | "permission" | "internal",
  message: string,
  retryable = false,
): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function isAppFailure(error: unknown): error is AppFailure {
  return error instanceof AppFailure;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (isAppFailure(error)) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return appFailure("permission", `Cannot ${operation}: permission denied.`, false);
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return appFailure("not_found", `Cannot ${operation}: draft file not found.`, false);
  }
  return appFailure("internal", `Cannot ${operation}.`, false);
}

function reportError(callback: DraftStoreOptions["onError"], error: unknown): void {
  if (!callback) return;
  const appError = toFailure(error, "read draft");
  try {
    callback(appError);
  } catch {
    // An error observer must never become an uncaught watcher exception.
  }
}

function scopeKey(scope: DraftScopeValue): string {
  return scope.kind === "thread" ? `thread:${scope.threadId}` : `folder:${scope.folder}`;
}

function scopesEqual(left: DraftScopeValue, right: DraftScopeValue): boolean {
  if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId;
  if (left.kind === "folder" && right.kind === "folder") return left.folder === right.folder;
  return false;
}

function normalizeScope(value: DraftScopeRequest): DraftScopeValue {
  const parsed = DraftScope.safeParse(value);
  if (!parsed.success) throw appFailure("invalid_args", "Draft scope is invalid.");
  return parsed.data;
}

function normalizeDraftInput(value: DraftInputValue): DraftInputValue {
  const parsed = DraftInput.safeParse(value);
  if (!parsed.success) throw appFailure("invalid_args", "Draft contents are invalid.");
  return parsed.data;
}

function normalizeStoredDraft(value: unknown): StoredDraftValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("kind" in value) || value.kind !== "draft") return null;
  if (!("version" in value) || value.version !== DRAFT_VERSION) return null;
  if (
    !("scope" in value) ||
    !("text" in value) ||
    !("attachments" in value) ||
    !("failedSends" in value) ||
    !("updatedAt" in value)
  ) {
    return null;
  }
  const scope = DraftScope.safeParse(value.scope);
  const input = DraftInput.safeParse({
    text: value.text,
    attachments: value.attachments,
    failedSends: value.failedSends,
  });
  if (!scope.success || !input.success || typeof value.updatedAt !== "string") return null;
  return {
    kind: "draft",
    scope: scope.data,
    text: input.data.text,
    attachments: input.data.attachments,
    failedSends: input.data.failedSends,
    updatedAt: value.updatedAt,
  };
}

function normalizeStoredTombstone(value: unknown): StoredTombstoneValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("kind" in value) || value.kind !== "cleared") return null;
  if (!("version" in value) || value.version !== DRAFT_VERSION) return null;
  if (!("scope" in value) || !("clearedAt" in value)) return null;
  const scope = DraftScope.safeParse(value.scope);
  if (!scope.success || typeof value.clearedAt !== "string") return null;
  return { kind: "cleared", scope: scope.data, clearedAt: value.clearedAt };
}

function parseStoredValue(content: string): StoredValue {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw appFailure("invalid_args", "Draft file contains malformed JSON.");
  }
  const tombstone = normalizeStoredTombstone(value);
  if (tombstone) return tombstone;
  const draft = normalizeStoredDraft(value);
  if (draft) return draft;
  throw appFailure("invalid_args", "Draft file has an unsupported format.");
}

function serializeDraft(scope: DraftScopeValue, input: DraftInputValue, updatedAt: string): string {
  const record = {
    version: DRAFT_VERSION,
    kind: "draft",
    scope,
    text: input.text,
    attachments: input.attachments,
    failedSends: input.failedSends.slice(-MAX_FAILED_SENDS),
    updatedAt,
  };
  return `${JSON.stringify(record)}\n`;
}

function serializeTombstone(scope: DraftScopeValue, clearedAt: string): string {
  return `${JSON.stringify({ version: DRAFT_VERSION, kind: "cleared", scope, clearedAt })}\n`;
}

function currentRevision(state: DraftState): Revision | null {
  return state.kind === "draft" ? state.snapshot.hash : null;
}

function materializeDraft(state: Extract<DraftState, { kind: "draft" }>): Draft {
  return {
    scope: state.value.scope,
    text: state.value.text,
    attachments: [...state.value.attachments],
    failedSends: [...state.value.failedSends].slice(-MAX_FAILED_SENDS),
    revision: state.snapshot.hash ?? "",
    updatedAt: state.value.updatedAt,
  };
}

export class DraftStoreService {
  readonly appDataDir: string;
  readonly draftsDir: string;
  readonly #options: DraftStoreOptions;
  readonly #watchers = new Map<string, ScopeWatcher>();
  readonly #subscriptions = new Map<number, Subscription>();
  #nextSubscriptionId = 1;

  constructor(options: DraftStoreOptions = {}) {
    this.#options = options;
    this.appDataDir = resolveAppDataDir({
      env:
        options.appDataDir === undefined
          ? options.env
          : { ...(options.env ?? {}), OMP_APP_DATA_DIR: options.appDataDir },
      homeDir: options.homeDir,
      cwd: options.cwd,
    });
    this.draftsDir = join(this.appDataDir, DRAFTS_DIRECTORY);
  }

  /** Returns attachment refs from every valid persisted draft; tombstones contribute none. */
  async referencedAttachments(): Promise<readonly AttachmentRef[]> {
    const refs = new Map<string, AttachmentRef>();
    for (const directory of [THREADS_DIRECTORY, FOLDERS_DIRECTORY]) {
      const root = join(this.draftsDir, directory);
      let entries: string[] = [];
      try {
        entries = (await fs.readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name);
      } catch (error) {
        const code = errorCode(error);
        const message = error instanceof Error ? error.message : "";
        if (
          code === "ENOENT" ||
          code === "ENOTDIR" ||
          message.includes("ENOENT") ||
          message.includes("ENOTDIR")
        ) {
          continue;
        }
        throw toFailure(error, "list draft attachments");
      }
      for (const entry of entries) {
        try {
          const value = parseStoredValue(await fs.readFile(join(root, entry), "utf8"));
          if (value.kind !== "draft") continue;
          for (const attachment of value.attachments) refs.set(attachment.id, attachment);
          for (const failedSend of value.failedSends) {
            for (const attachment of failedSend.attachments) refs.set(attachment.id, attachment);
          }
        } catch (error) {
          throw toFailure(error, "read draft attachments");
        }
      }
    }
    return [...refs.values()];
  }

  async get(args: DraftGetRequest): Promise<{ draft: Draft | null }> {
    const scope = normalizeScope(args.scope);
    const state = await this.readState(scope);
    return { draft: state.kind === "draft" ? materializeDraft(state) : null };
  }

  async save(args: DraftSaveRequest): Promise<Draft> {
    const scope = normalizeScope(args.scope);
    const input = normalizeDraftInput(args.draft);
    const before = await this.readState(scope);
    const beforeRevision = currentRevision(before);
    this.assertExpectedRevision(args.expectedRevision, beforeRevision);

    const updatedAt = new Date().toISOString();
    const content = serializeDraft(scope, input, updatedAt);
    let result: { hash: string };
    try {
      result = await compareAndSwapFile(this.pathForScope(scope), content, before.snapshot.hash);
    } catch (error) {
      if (isConflict(error)) throw await this.conflictFor(scope);
      throw toFailure(error, "save draft");
    }
    return {
      scope,
      text: input.text,
      attachments: [...input.attachments],
      failedSends: input.failedSends.slice(-MAX_FAILED_SENDS),
      revision: result.hash,
      updatedAt,
    };
  }

  async clear(args: DraftClearRequest): Promise<DraftClearResult> {
    const scope = normalizeScope(args.scope);
    const before = await this.readState(scope);
    const beforeRevision = currentRevision(before);
    this.assertExpectedRevision(args.expectedRevision, beforeRevision);
    if (before.kind !== "draft") return { cleared: false, revision: null };

    const content = serializeTombstone(scope, new Date().toISOString());
    try {
      await compareAndSwapFile(this.pathForScope(scope), content, before.snapshot.hash);
    } catch (error) {
      if (isConflict(error)) throw await this.conflictFor(scope);
      throw toFailure(error, "clear draft");
    }
    return { cleared: true, revision: null };
  }

  subscribe(scopeRequest: DraftScopeRequest, listener: DraftChangeListener): () => void {
    const scope = normalizeScope(scopeRequest);
    const key = scopeKey(scope);
    const id = this.#nextSubscriptionId++;
    let watcher = this.#watchers.get(key);
    if (!watcher) {
      const path = this.pathForScope(scope);
      try {
        const fileWatcher = watchFile(path, () => this.handleFileChange(key), {
          debounceMs: this.#options.watchDebounceMs,
          onError: (error) => reportError(this.#options.onError, error),
        });
        watcher = { scope, path, watcher: fileWatcher, listeners: new Set() };
        this.#watchers.set(key, watcher);
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
    watcher?.listeners.add(id);
    this.#subscriptions.set(id, { id, scopeKey: key, listener });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#subscriptions.delete(id);
      const current = this.#watchers.get(key);
      if (!current) return;
      current.listeners.delete(id);
      if (current.listeners.size === 0) {
        current.watcher.dispose();
        this.#watchers.delete(key);
      }
    };
  }

  watch(scope: DraftScopeRequest, listener: DraftChangeListener): () => void {
    return this.subscribe(scope, listener);
  }

  onChanged(scope: DraftScopeRequest, listener: DraftChangeListener): () => void {
    return this.subscribe(scope, listener);
  }

  dispose(): void {
    for (const watcher of this.#watchers.values()) watcher.watcher.dispose();
    this.#watchers.clear();
    this.#subscriptions.clear();
  }

  private pathForScope(scope: DraftScopeValue): string {
    const directory = scope.kind === "thread" ? THREADS_DIRECTORY : FOLDERS_DIRECTORY;
    const id = hashContent(scope.kind === "thread" ? scope.threadId : scope.folder);
    return join(this.draftsDir, directory, `${id}.json`);
  }

  private async readState(scope: DraftScopeValue): Promise<DraftState> {
    const path = this.pathForScope(scope);
    let snapshot: FileSnapshot;
    try {
      snapshot = await readFileSnapshot(path);
    } catch (error) {
      throw toFailure(error, "read draft");
    }
    if (!snapshot.exists) return { kind: "missing", snapshot, value: null };
    const value = parseStoredValue(snapshot.content ?? "");
    if (!scopesEqual(value.scope, scope))
      throw appFailure("internal", "Draft file scope does not match its key.");
    if (value.kind === "cleared") return { kind: "cleared", snapshot, value };
    return { kind: "draft", snapshot, value };
  }

  private assertExpectedRevision(expected: Revision | null, current: Revision | null): void {
    if (expected !== current) throw new DraftConflict(current);
  }

  private async conflictFor(scope: DraftScopeValue): Promise<DraftConflict> {
    try {
      const state = await this.readState(scope);
      return new DraftConflict(currentRevision(state));
    } catch {
      return new DraftConflict(null);
    }
  }

  private async handleFileChange(key: string): Promise<void> {
    const watcher = this.#watchers.get(key);
    if (!watcher) return;
    let state: DraftState;
    try {
      state = await this.readState(watcher.scope);
    } catch (error) {
      reportError(this.#options.onError, error);
      return;
    }
    const draft = state.kind === "draft" ? materializeDraft(state) : null;
    const change: DraftChanged = { scope: watcher.scope, draft };
    for (const id of watcher.listeners) {
      const subscription = this.#subscriptions.get(id);
      if (!subscription) continue;
      try {
        const result = subscription.listener(change);
        if (result && typeof result === "object" && "then" in result) await result;
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
  }
}

function isConflict(error: unknown): boolean {
  return isAppFailure(error) && error.appError.code === "conflict";
}

export function createDraftStore(options: DraftStoreOptions = {}): DraftStoreService {
  return new DraftStoreService(options);
}

export { DraftStoreService as DraftStoreImpl, DraftStoreService as DraftStore };
