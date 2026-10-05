import type { OmpWire, ThreadId } from "@omp-app/contracts";
import { z } from "zod";

/** The assistant-ui thread-list status; native sessions are currently all `regular`. */
export const RemoteThreadStatus = z.enum(["regular", "archived"]);
export type RemoteThreadStatus = z.infer<typeof RemoteThreadStatus>;

export const RemoteThreadMetadata = z.strictObject({
  status: RemoteThreadStatus,
  remoteId: z.string().min(1),
  externalId: z.string().min(1).optional(),
  title: z.string().optional(),
  lastMessageAt: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type RemoteThreadMetadata = z.infer<typeof RemoteThreadMetadata>;

export const RemoteThreadListPage = z.strictObject({
  threads: z.array(RemoteThreadMetadata),
  nextCursor: z.string().min(1).optional(),
});
export type RemoteThreadListPage = z.infer<typeof RemoteThreadListPage>;

export interface RemoteThreadListAdapter {
  list(params?: { readonly after?: string }): Promise<RemoteThreadListPage>;
  fetch(threadId: ThreadId): Promise<RemoteThreadMetadata>;
  initialize(
    threadId: ThreadId,
  ): Promise<{ readonly remoteId: string; readonly externalId?: string }>;
  rename(threadId: ThreadId, newTitle: string): Promise<void>;
  updateCustom?(threadId: ThreadId, custom: Record<string, unknown> | undefined): Promise<void>;
  archive(threadId: ThreadId): Promise<void>;
  unarchive(threadId: ThreadId): Promise<void>;
  delete(threadId: ThreadId): Promise<void>;
  generateTitle(threadId: ThreadId, messages: readonly unknown[]): Promise<unknown>;
}

/** Read-only bridge from R1's selected thread to R0's normalized history. */
export interface ThreadHistoryAdapter {
  loadInitial(threadId: ThreadId): Promise<void>;
  refetch(threadId: ThreadId): Promise<void>;
  loadMessagesPage(
    threadId: ThreadId,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<OmpWire.MessagesPage>;
}
