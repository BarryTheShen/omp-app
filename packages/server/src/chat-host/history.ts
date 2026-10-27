/**
 * The chat's history for the history methods: entries after a cursor (`get_entries`) and stable pages of the session's
 * messages (`get_messages_page`), with omp's cursors and refusals (18.12.6 `modes/rpc/rpc-compat.ts` and
 * `modes/rpc/rpc-messages.ts`). Unlike omp's RPC, a page has no byte budget: a protocol line has no size cap.
 */
import { z } from "zod";
import { HostMethodError } from "./method-error";

/** Entries after the one with id `since`, all without it. An id the session does not have is `unknown_since`. */
export function selectEntries<Entry extends { readonly id: string }>(
  entries: readonly Entry[],
  since: string | undefined,
): Entry[] {
  if (since === undefined) return [...entries];
  const index = entries.findIndex((entry) => entry.id === since);
  if (index === -1) throw new HostMethodError("unknown_since", `Unknown entries cursor: ${since}`);
  return entries.slice(index + 1);
}

/** The messages a page cursor belongs to: the session, its leaf and its message count when the page was read. */
export interface MessagesSnapshot {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly messageCount: number;
}

export interface MessagesPageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

/** omp's default page size. */
const DEFAULT_PAGE_LIMIT = 100;

const CursorPayload = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(256),
    leafId: z.string().min(1).max(256).nullable(),
    messageCount: z.int().min(0),
    offset: z.int().min(0),
  })
  .refine((cursor) => cursor.offset <= cursor.messageCount);
type CursorPayload = z.infer<typeof CursorPayload>;

/**
 * One page of `messages`, from the start or from the cursor's place. A cursor read before the session, its leaf or its
 * message count changed is `stale_cursor`: the reader starts over.
 */
export function pageMessages<Message>(
  messages: readonly Message[],
  snapshot: MessagesSnapshot,
  options: MessagesPageOptions = {},
): { messages: Message[]; nextCursor?: string; totalMessages: number } {
  let offset = 0;
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    if (
      cursor.sessionId !== snapshot.sessionId ||
      cursor.leafId !== snapshot.leafId ||
      cursor.messageCount !== snapshot.messageCount
    ) {
      throw new HostMethodError("stale_cursor", "The message cursor is stale");
    }
    offset = cursor.offset;
  }
  const page = messages.slice(offset, offset + (options.limit ?? DEFAULT_PAGE_LIMIT));
  const next = offset + page.length;
  return {
    messages: page,
    ...(next < messages.length ? { nextCursor: encodeCursor(snapshot, next) } : {}),
    totalMessages: messages.length,
  };
}

function encodeCursor(snapshot: MessagesSnapshot, offset: number): string {
  const payload: CursorPayload = {
    version: 1,
    sessionId: snapshot.sessionId,
    leafId: snapshot.leafId,
    messageCount: snapshot.messageCount,
    offset,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  const invalid = new Error("Invalid message cursor");
  // A canonical base64url string only: the same cursor can not be spelled two ways.
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid;
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw invalid;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid;
  }
  const parsed = CursorPayload.safeParse(value);
  if (!parsed.success) throw invalid;
  return parsed.data;
}
