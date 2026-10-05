import type { OmpWire, PortCallOptions, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;
type MessagesPageResult = OmpWire.MessagesPage;

export interface LoadMessagesPageOptions {
  /** Opaque cursor from a previous page's `nextCursor`; omit to start from the beginning. */
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignalLike;
}

/** True when `get_messages_page` rejected because the session is streaming or compacting. */
export function isSessionBusyError(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.omp?.code === "session_busy";
}

/** True when a `get_messages_page` cursor no longer matches the session; paging must restart. */
export function isStaleCursorError(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.omp?.code === "stale_cursor";
}

/** One stable, byte-bounded page of this thread's messages in chronological order (no entry ids). */
export async function loadMessagesPage(
  send: RpcSessionSend,
  threadId: ThreadId,
  options: LoadMessagesPageOptions = {},
): Promise<MessagesPageResult> {
  const { cursor, limit, signal } = options;
  const result = await send(
    { threadId, command: { type: "get_messages_page", cursor, limit } },
    { signal },
  );
  return result as MessagesPageResult;
}

export interface IterateMessagePagesOptions {
  readonly limit?: number;
  readonly signal?: AbortSignalLike;
}

/**
 * Drains every page in chronological order, mirroring omp's own `RpcClient.getMessages()` safety
 * checks: a changing or non-finite `totalMessages`, a repeated cursor, or a short final result
 * fails fast instead of looping or silently duplicating messages. `session_busy`/`stale_cursor`
 * propagate unchanged so a caller can retry (busy) or restart paging (stale cursor); see
 * `isSessionBusyError`/`isStaleCursorError`.
 */
export async function* iterateMessagePages(
  send: RpcSessionSend,
  threadId: ThreadId,
  options: IterateMessagePagesOptions = {},
): AsyncGenerator<readonly OmpWire.AgentMessage[], void, void> {
  const seenCursors = new Set<string>();
  let totalMessages: number | undefined;
  let fetchedMessages = 0;
  let cursor: string | undefined;
  do {
    const page = await loadMessagesPage(send, threadId, {
      cursor,
      limit: options.limit,
      signal: options.signal,
    });
    if (
      !Number.isSafeInteger(page.totalMessages) ||
      page.totalMessages < 0 ||
      (totalMessages !== undefined && page.totalMessages !== totalMessages)
    ) {
      throw new AppFailure({
        code: "internal",
        message: "omp returned an inconsistent message-page total",
        retryable: false,
      });
    }
    totalMessages = page.totalMessages;
    fetchedMessages += page.messages.length;
    yield page.messages;
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new AppFailure({
          code: "internal",
          message: "omp repeated a message-page cursor",
          retryable: false,
        });
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  if (totalMessages === undefined || fetchedMessages !== totalMessages) {
    throw new AppFailure({
      code: "internal",
      message: "omp message pagination ended before the advertised total",
      retryable: false,
    });
  }
}
