import type { AppendMessage } from "@assistant-ui/react";
import {
  type EntryId,
  EntryId as EntryIdSchema,
  type OmpWire,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { OmpRuntimeStore } from "@/modules/R0/store";

export const sourceThread: ThreadId = ThreadIdSchema.parse("source-thread");
export const userEntry: EntryId = EntryIdSchema.parse("user-entry");

export const pngImage: OmpWire.ImageContent = {
  type: "image",
  data: "aW1hZ2UtYnl0ZXM=",
  mimeType: "image/png",
};

function userEntryRecord(content: unknown, entryId: EntryId): Record<string, unknown> {
  return {
    type: "message",
    id: entryId,
    parentId: null,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

/** A chat that holds one stored user message with the given content, as omp's session file stores it. */
export function storeWithUserMessage(
  content: unknown,
  entryId: EntryId = userEntry,
): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId: sourceThread });
  store.pairEndedMessages([userEntryRecord(content, entryId)], entryId);
  return store;
}

/**
 * An assistant-ui append that edits `sourceId` and carries the replacement. assistant-ui's AppendMessage
 * has many fields the handlers never read, so this fixture supplies only the ones they do.
 */
export function editAppend(
  sourceId: string | null,
  text: string,
  images: readonly OmpWire.ImageContent[] = [],
): AppendMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image",
        image: `data:${image.mimeType};base64,${image.data}`,
      })),
    ],
    attachments: [],
    metadata: { custom: {} },
    createdAt: new Date(0),
    parentId: null,
    sourceId,
    runConfig: undefined,
  } as unknown as AppendMessage;
}
