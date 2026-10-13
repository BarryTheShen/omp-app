import type { ThreadMessageLike } from "@assistant-ui/react";
import type { EntryId, MessageKey, ThreadId } from "@omp-app/contracts";

/**
 * The rendering preference U1 owns. It is deliberately local browser policy, not an omp setting:
 * D1/S1 own persisted model/appearance settings while U1 decides how the transcript is disclosed.
 */
export type TranscriptDisplayPolicy = {
  readonly thinking: "visible" | "hidden";
  readonly tools: "visible" | "hidden";
  readonly expandTools: boolean;
};

export type MessageTiming = {
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
};

export type MessagePartModel =
  | {
      readonly type: "text";
      readonly text: string;
      readonly status: "running" | "complete" | "incomplete";
      readonly markdown: boolean;
    }
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly status: "running" | "complete" | "incomplete";
      readonly hidden: boolean;
      readonly timing?: MessageTiming;
    }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
      readonly alt?: string;
    }
  | {
      readonly type: "file";
      readonly name?: string;
      readonly data: string;
      readonly mimeType: string;
      readonly sourceType?: "url" | "id";
    }
  | {
      readonly type: "source";
      readonly sourceType: "url" | "document";
      readonly id: string;
      readonly url?: string;
      readonly title?: string;
      readonly filename?: string;
      readonly mediaType?: string;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argsText: string;
      readonly args: unknown;
      readonly result?: unknown;
      readonly isError?: boolean;
      readonly messages?: readonly ThreadMessageLike[];
    }
  | { readonly type: "data"; readonly name: string; readonly data: unknown };

export type RawTranscriptPart = {
  readonly index: number;
  readonly type: MessagePartModel["type"] | "notice" | "code" | "command";
  /** Exact source record supplied by R0/domain normalization; U1 never re-parses omp wire JSON. */
  readonly source: unknown;
  readonly plainText?: string;
  readonly markdown?: string;
};

/** Immutable source record used by D4/copy; independent from disclosure, sanitization and DOM. */
export type RawTranscriptContent = {
  readonly messageKey: string;
  readonly source: "omp" | "derived" | "host";
  readonly markdown: string;
  readonly plainText: string;
  readonly parts: readonly RawTranscriptPart[];
};

export type TranscriptRow = {
  readonly key: string;
  readonly messageKey: string;
  readonly kind: "message" | "notice" | "divider" | "status" | "tool";
  readonly role?: "user" | "assistant" | "system";
  readonly createdAt?: Date;
  /** Repository wrapper topology only; never put parentId on ThreadMessageLike. */
  readonly parentId?: EntryId | null;
  readonly message?: ThreadMessageLike;
  readonly parts: readonly MessagePartModel[];
  readonly raw?: RawTranscriptContent;
  /** Hidden persisted/session metadata remains in the model but has no transcript DOM row. */
  readonly hidden?: boolean;
  readonly source: "omp" | "derived" | "host";
};

export type TranscriptSnapshot = {
  readonly rows: readonly TranscriptRow[];
  /** Provisional → persisted aliases; the old key remains resolvable after pairing. */
  readonly aliases: Readonly<Record<string, string>>;
  readonly revision: number;
};

const EMPTY_ROWS: readonly TranscriptRow[] = Object.freeze([]);
const EMPTY_ALIASES: Readonly<Record<string, string>> = Object.freeze({});

function freezeRow(row: TranscriptRow): TranscriptRow {
  return Object.freeze({
    ...row,
    parts: Object.freeze([...row.parts]),
    raw: row.raw
      ? Object.freeze({ ...row.raw, parts: Object.freeze([...row.raw.parts]) })
      : undefined,
  });
}

function freezeSnapshot(
  rows: readonly TranscriptRow[],
  aliases: Readonly<Record<string, string>>,
  revision: number,
): TranscriptSnapshot {
  return Object.freeze({
    rows: Object.freeze(rows.map(freezeRow)),
    aliases: Object.freeze({ ...aliases }),
    revision,
  });
}

export function createTranscriptSnapshot(
  rows: readonly TranscriptRow[] = EMPTY_ROWS,
  aliases: Readonly<Record<string, string>> = EMPTY_ALIASES,
): TranscriptSnapshot {
  return freezeSnapshot(rows, aliases, 0);
}

/** Resolves a key through the immutable alias chain, tolerating a malformed cycle defensively. */
export function resolveMessageKey(snapshot: TranscriptSnapshot, key: string): string {
  const visited = new Set<string>();
  let current = key;
  while (!visited.has(current)) {
    visited.add(current);
    const next = snapshot.aliases[current];
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Replaces one stable row without changing any unrelated row object or key. */
export function upsertTranscriptRow(
  snapshot: TranscriptSnapshot,
  row: TranscriptRow,
): TranscriptSnapshot {
  const canonicalKey = resolveMessageKey(snapshot, row.messageKey);
  const nextRow =
    canonicalKey === row.messageKey ? row : { ...row, key: canonicalKey, messageKey: canonicalKey };
  const index = snapshot.rows.findIndex((candidate) => candidate.messageKey === canonicalKey);
  const rows = [...snapshot.rows];
  if (index < 0) rows.push(nextRow);
  else rows[index] = nextRow;
  return freezeSnapshot(rows, snapshot.aliases, snapshot.revision + 1);
}

/**
 * Pairs a provisional stream key with its persisted C0 key while retaining the old key as an alias.
 * A row already persisted under the target key wins; the provisional duplicate is removed.
 */
export function aliasTranscriptKey(
  snapshot: TranscriptSnapshot,
  provisionalKey: string,
  persistedKey: string,
): TranscriptSnapshot {
  const target = resolveMessageKey(snapshot, persistedKey);
  const persistedAlreadyExists = snapshot.rows.some((row) => row.messageKey === target);
  const aliases = { ...snapshot.aliases, [provisionalKey]: target };
  const rows = snapshot.rows
    .filter((row) => !(persistedAlreadyExists && row.messageKey === provisionalKey))
    .map((row) =>
      row.messageKey === provisionalKey ? { ...row, key: target, messageKey: target } : row,
    )
    .filter(
      (row, index, all) =>
        all.findIndex((candidate) => candidate.messageKey === row.messageKey) === index,
    );
  return freezeSnapshot(rows, aliases, snapshot.revision + 1);
}

export function isTranscriptRowVisible(row: TranscriptRow): boolean {
  return row.hidden !== true;
}

/** Persisted entry types whose metadata is retained for history but never rendered as a row. */
export const HIDDEN_SESSION_ENTRY_TYPES = [
  "credential_pin",
  "custom",
  "label",
  "mode_change",
  "model_change",
  "reset_boundary",
  "service_tier_change",
  "session_init",
  "thinking_level_change",
  "title_change",
  "ttsr_injection",
] as const;

export type HiddenSessionEntryType = (typeof HIDDEN_SESSION_ENTRY_TYPES)[number];

export function isHiddenSessionEntryType(type: string): type is HiddenSessionEntryType {
  return (HIDDEN_SESSION_ENTRY_TYPES as readonly string[]).includes(type);
}

/** A stable key helper for rows derived from non-message metadata. */
export function derivedRowKey(
  messageKey: MessageKey | string,
  kind: TranscriptRow["kind"],
): string {
  return `row:${kind}:${messageKey}`;
}

/** ThreadId is imported in the model contract so consumers can brand their model scope explicitly. */
export type TranscriptThreadScope = { readonly threadId: ThreadId };
