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
  write(scope: DraftScope, held: BufferedDraft): void;
  clear(scope: DraftScope): void;
  /** The draft that text typed before the scope loaded replaced, kept for this tab's session, or null. */
  readReplaced(scope: DraftScope): DraftInput | null;
  writeReplaced(scope: DraftScope, input: DraftInput): void;
  clearReplaced(scope: DraftScope): void;
}

/** The part of Web Storage the buffer uses. The app passes `localStorage`, so the copy survives a reload, a closed tab and a restarted browser. */
export interface DraftBufferStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "omp-app:u2:draft:";

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

function attempt(onError: (error: unknown) => void, action: () => void): void {
  try {
    action();
  } catch (error) {
    onError(error);
  }
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
      attempt(onError, () =>
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
      attempt(onError, () =>
        storage.setItem(replacedKeyFor(scope), JSON.stringify({ version: 1, input })),
      );
    },
    clearReplaced(scope) {
      attempt(onError, () => storage.removeItem(replacedKeyFor(scope)));
    },
  };
}

/** Keeps unsaved and replaced draft contents in local storage for this tab until saved or restored. */
export function localDraftBuffer(onError: (error: unknown) => void): DraftBuffer | undefined {
  return typeof window === "undefined"
    ? undefined
    : createDraftBuffer(window.localStorage, onError);
}
