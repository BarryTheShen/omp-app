import { AppFailure, DraftInput, type DraftScope, Revision } from "@omp-app/contracts";
import { z } from "zod";
import { draftScopeStream } from "./drafts";

/**
 * Text the person has typed in a scope that the server has not saved yet, the app's copy of it in this tab.
 *
 * - `baseRevision`: the server revision the text was typed on (`null` when the scope had no stored draft).
 * - `saving`: the text of a save this tab sent and has not heard back about, or `null`. The save may have
 *   landed without its answer reaching the page, for example when the page is reloaded mid-save.
 */
export interface BufferedDraft {
  readonly input: DraftInput;
  readonly baseRevision: Revision | null;
  readonly saving: DraftInput | null;
}

export interface DraftBuffer {
  /** The scope's unsaved text, or null. A value that cannot be read is dropped and reported. */
  read(scope: DraftScope): BufferedDraft | null;
  /** Keeps the copy. Returns false only when the browser refused it (its storage is full or closed). A deleted chat keeps no copy, which is not a refusal. */
  write(scope: DraftScope, held: BufferedDraft): boolean;
  clear(scope: DraftScope): void;
  /** The draft that text typed before the scope loaded replaced, kept for this tab's session, or null. */
  readReplaced(scope: DraftScope): DraftInput | null;
  writeReplaced(scope: DraftScope, input: DraftInput): void;
  clearReplaced(scope: DraftScope): void;
  /** The text of a send this tab made from the scope, not yet known to be admitted, or null. It outlives the copy's save. */
  readSent(scope: DraftScope): string | null;
  writeSent(scope: DraftScope, text: string): void;
  clearSent(scope: DraftScope): void;
}

/** The part of Web Storage the buffer uses. The app passes `localStorage`, so the copy survives a reload, a closed tab and a restarted browser. */
export interface DraftBufferStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The storage the cleanup of deleted chats reads: the keys the browser holds, as well as the buffer's part of it. */
export interface KeyedDraftStorage extends DraftBufferStorage {
  keys(): string[];
}

const KEY_PREFIX = "omp-app:u2:draft:";
const THREAD_COPY_PREFIX = `${KEY_PREFIX}thread:`;
const REPLACED_THREAD_COPY_PREFIX = `${KEY_PREFIX}replaced:thread:`;
const SENT_THREAD_COPY_PREFIX = `${KEY_PREFIX}sent:thread:`;
/** The key this browser keeps the ids of the chats it deleted under. */
const DELETED_CHATS_KEY = `${KEY_PREFIX}deleted-chats`;

const StoredDraft = z.strictObject({
  version: z.literal(1),
  input: DraftInput,
  baseRevision: Revision.nullable(),
  saving: DraftInput.nullable(),
});

const StoredReplaced = z.strictObject({
  version: z.literal(1),
  input: DraftInput,
});

const StoredSent = z.strictObject({
  version: z.literal(1),
  text: z.string(),
});

const StoredDeletedChats = z.array(z.string().min(1));

function replacedKeyFor(scope: DraftScope): string {
  return `${KEY_PREFIX}replaced:${draftScopeStream(scope)}`;
}

function parseStoredReplaced(raw: string): DraftInput | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredReplaced.safeParse(value);
  return parsed.success ? parsed.data.input : null;
}

function sentKeyFor(scope: DraftScope): string {
  return `${KEY_PREFIX}sent:${draftScopeStream(scope)}`;
}

function parseStoredSent(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredSent.safeParse(value);
  return parsed.success ? parsed.data.text : null;
}

function keyFor(scope: DraftScope): string {
  return `${KEY_PREFIX}${draftScopeStream(scope)}`;
}

/** Whether this browser holds unsent text for the scope. Storage the browser refuses to open holds none. */
export function hasLocalDraft(scope: DraftScope): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(keyFor(scope)) !== null;
  } catch {
    return false;
  }
}

function parseStored(raw: string): BufferedDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredDraft.safeParse(value);
  return parsed.success
    ? {
        input: parsed.data.input,
        baseRevision: parsed.data.baseRevision,
        saving: parsed.data.saving,
      }
    : null;
}

/** Runs one storage action. Returns false, after reporting the failure, when the storage refuses it. */
function attempt(onError: (error: unknown) => void, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

/** Whether the scope is a chat deleted in this browser: such a chat keeps no copy, and a copy left from before is not read. */
function isDeletedChat(
  storage: DraftBufferStorage,
  scope: DraftScope,
  onError: (error: unknown) => void,
): boolean {
  return scope.kind === "thread" && deletedChatIds(storage, onError).has(scope.threadId);
}

/**
 * A buffer over `storage`. A write or removal the storage refuses is reported, and the draft stays in
 * memory, where the controller still saves it. A value that cannot be read is dropped and reported: it is
 * never restored in part.
 */
export function createDraftBuffer(
  storage: DraftBufferStorage,
  onError: (error: unknown) => void,
): DraftBuffer {
  return {
    read(scope) {
      if (isDeletedChat(storage, scope, onError)) return null;
      const key = keyFor(scope);
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const held = parseStored(raw);
      if (held !== null) return held;
      attempt(onError, () => storage.removeItem(key));
      onError(
        new AppFailure({
          code: "internal",
          message: "A saved draft in this tab could not be read and was dropped",
          retryable: false,
        }),
      );
      return null;
    },
    write(scope, held) {
      // A deleted chat keeps no copy: nothing is written, and nothing is refused.
      if (isDeletedChat(storage, scope, onError)) return true;
      return attempt(onError, () =>
        storage.setItem(
          keyFor(scope),
          JSON.stringify({
            version: 1,
            input: held.input,
            baseRevision: held.baseRevision,
            saving: held.saving,
          }),
        ),
      );
    },
    clear(scope) {
      attempt(onError, () => storage.removeItem(keyFor(scope)));
    },
    readReplaced(scope) {
      if (isDeletedChat(storage, scope, onError)) return null;
      const key = replacedKeyFor(scope);
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const input = parseStoredReplaced(raw);
      if (input !== null) return input;
      attempt(onError, () => storage.removeItem(key));
      onError(
        new AppFailure({
          code: "internal",
          message: "An earlier draft in this tab could not be read and was dropped",
          retryable: false,
        }),
      );
      return null;
    },
    writeReplaced(scope, input) {
      if (isDeletedChat(storage, scope, onError)) return;
      attempt(onError, () =>
        storage.setItem(replacedKeyFor(scope), JSON.stringify({ version: 1, input })),
      );
    },
    clearReplaced(scope) {
      attempt(onError, () => storage.removeItem(replacedKeyFor(scope)));
    },
    readSent(scope) {
      if (isDeletedChat(storage, scope, onError)) return null;
      const key = sentKeyFor(scope);
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const text = parseStoredSent(raw);
      if (text !== null) return text;
      attempt(onError, () => storage.removeItem(key));
      onError(
        new AppFailure({
          code: "internal",
          message: "A send in this tab could not be read and was dropped",
          retryable: false,
        }),
      );
      return null;
    },
    writeSent(scope, text) {
      if (isDeletedChat(storage, scope, onError)) return;
      attempt(onError, () =>
        storage.setItem(sentKeyFor(scope), JSON.stringify({ version: 1, text })),
      );
    },
    clearSent(scope) {
      attempt(onError, () => storage.removeItem(sentKeyFor(scope)));
    },
  };
}

/** The chat a local copy key belongs to, or undefined for a key that is no chat's copy (the New chat's copy, or any other key). */
function threadIdOfCopyKey(key: string): string | undefined {
  if (key.startsWith(THREAD_COPY_PREFIX)) return key.slice(THREAD_COPY_PREFIX.length);
  if (key.startsWith(REPLACED_THREAD_COPY_PREFIX)) {
    return key.slice(REPLACED_THREAD_COPY_PREFIX.length);
  }
  if (key.startsWith(SENT_THREAD_COPY_PREFIX)) return key.slice(SENT_THREAD_COPY_PREFIX.length);
  return undefined;
}

/**
 * Removes the local copies of chats that no longer exist. A chat that cannot be checked keeps its copies: text this
 * browser holds is removed only once its chat is known to be gone. A failed check or removal is reported.
 */
export async function removeDeletedChatCopies(
  storage: KeyedDraftStorage,
  chatExists: (threadId: string) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<void> {
  for (const key of storage.keys()) {
    const threadId = threadIdOfCopyKey(key);
    if (threadId === undefined) continue;
    let exists: boolean;
    try {
      exists = await chatExists(threadId);
    } catch (error) {
      onError(error);
      continue;
    }
    if (!exists) attempt(onError, () => storage.removeItem(key));
  }
}

/** Removes this browser's local copies of one chat at once, when the chat is deleted in this tab. */
export function removeChatCopies(
  storage: DraftBufferStorage,
  threadId: string,
  onError: (error: unknown) => void,
): void {
  attempt(onError, () => storage.removeItem(`${THREAD_COPY_PREFIX}${threadId}`));
  attempt(onError, () => storage.removeItem(`${REPLACED_THREAD_COPY_PREFIX}${threadId}`));
  attempt(onError, () => storage.removeItem(`${SENT_THREAD_COPY_PREFIX}${threadId}`));
}

/** The chats this browser deleted: a copy of one of them that is still here is removed on the next load. */
export function deletedChatIds(
  storage: DraftBufferStorage,
  onError: (error: unknown) => void,
): ReadonlySet<string> {
  const raw = readDeletedChats(storage, onError);
  if (raw === null) return new Set();
  const ids = parseDeletedChats(raw);
  if (ids === null) {
    onError(
      new AppFailure({
        code: "internal",
        message: "The list of deleted chats in this tab could not be read",
        retryable: false,
      }),
    );
    return new Set();
  }
  return new Set(ids);
}

function readDeletedChats(
  storage: DraftBufferStorage,
  onError: (error: unknown) => void,
): string | null {
  try {
    return storage.getItem(DELETED_CHATS_KEY);
  } catch (error) {
    onError(error);
    return null;
  }
}

/** The ids in the stored list, or null when the stored text is not such a list. */
function parseDeletedChats(raw: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredDeletedChats.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Records a chat this browser deleted, and removes its local copies now. */
export function recordDeletedChat(
  storage: KeyedDraftStorage,
  threadId: string,
  onError: (error: unknown) => void,
): void {
  const ids = deletedChatIds(storage, onError);
  if (!ids.has(threadId)) {
    attempt(onError, () => storage.setItem(DELETED_CHATS_KEY, JSON.stringify([...ids, threadId])));
  }
  removeChatCopies(storage, threadId, onError);
}

/** This browser's local storage with its keys listed, for the cleanup of deleted chats. Undefined when no window exists. */
export function localDraftStorage(): KeyedDraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  const storage = window.localStorage;
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    keys: () => Object.keys(storage),
  };
}

/** Keeps unsaved and replaced draft contents in local storage for this tab until saved or restored. */
export function localDraftBuffer(onError: (error: unknown) => void): DraftBuffer | undefined {
  return typeof window === "undefined"
    ? undefined
    : createDraftBuffer(window.localStorage, onError);
}
