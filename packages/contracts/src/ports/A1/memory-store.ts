import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";
import { Cursor, JsonValue, Revision, Timestamp } from "./shared";

export const MemoryScope = z.enum(["global", "project", "session"]);
export type MemoryScope = z.infer<typeof MemoryScope>;
/** omp v18.6.1 mnemopi mints working-memory ids with `generateId()` as 16 lowercase SHA-256 hex characters (`packages/mnemopi/src/util/ids.ts:1-20`, used by `core/beam/store.ts:~470`). */
export const MemoryId = z.string().regex(/^[a-f0-9]{16}$/, "expected a memory id minted by omp");
export type MemoryId = z.infer<typeof MemoryId>;

export const MemoryProvenance = z.strictObject({
  source: z.enum(["omp-memory", "command", "backend"]),
  scope: MemoryScope,
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;

export const MemoryChangedReason = z.enum(["command", "backend"]);
export type MemoryChangedReason = z.infer<typeof MemoryChangedReason>;

/** Safe, browser-visible metadata; backend paths and credentials never appear here. */
export const MemoryEntry = z.strictObject({
  id: MemoryId,
  scope: MemoryScope,
  folder: FolderPath.nullable(),
  threadId: ThreadId.nullable(),
  namespace: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), JsonValue),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  sensitive: z.boolean(),
  provenance: MemoryProvenance.optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryListArgs = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  threadId: ThreadId.optional(),
  cursor: Cursor.optional(),
});
export type MemoryListArgs = z.infer<typeof MemoryListArgs>;

export const MemoryListResult = z.strictObject({
  parsed: z.boolean(),
  rawText: z.string(),
  entries: z.array(MemoryEntry),
  nextCursor: Cursor.nullable(),
  revision: Revision,
});
export type MemoryListResult = z.infer<typeof MemoryListResult>;

export const MemoryGetArgs = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  threadId: ThreadId.optional(),
  id: MemoryId,
});
export type MemoryGetArgs = z.infer<typeof MemoryGetArgs>;

export const MemoryGetResult = z.strictObject({
  parsed: z.boolean(),
  rawText: z.string(),
  entry: MemoryEntry.nullable(),
});
export type MemoryGetResult = z.infer<typeof MemoryGetResult>;

export const MemoryWriteArgs = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  threadId: ThreadId.optional(),
  id: MemoryId.optional(),
  content: z.string(),
  metadata: z.record(z.string(), JsonValue),
  sensitive: z.boolean(),
  expectedRevision: Revision.nullable(),
});
export type MemoryWriteArgs = z.infer<typeof MemoryWriteArgs>;

export const MemoryWriteResult = z.strictObject({
  parsed: z.boolean(),
  rawText: z.string(),
  entry: MemoryEntry.nullable(),
  revision: Revision.nullable(),
  previousRevision: Revision.nullable(),
});
export type MemoryWriteResult = z.infer<typeof MemoryWriteResult>;

export const MemoryDeleteArgs = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  threadId: ThreadId.optional(),
  id: MemoryId,
  confirmed: z.boolean().default(false),
  expectedRevision: Revision.nullable(),
});
export type MemoryDeleteArgs = z.infer<typeof MemoryDeleteArgs>;

export const MemoryDeleteResult = z.strictObject({
  parsed: z.boolean(),
  rawText: z.string(),
  revision: Revision.nullable(),
});
export type MemoryDeleteResult = z.infer<typeof MemoryDeleteResult>;

export const MemoryClearOperation = z.enum(["clear", "reset", "rebuild"]);
export type MemoryClearOperation = z.infer<typeof MemoryClearOperation>;

export const MemoryClearArgs = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  threadId: ThreadId.optional(),
  operation: MemoryClearOperation.default("clear"),
  confirmed: z.boolean().default(false),
  expectedRevision: Revision.nullable(),
});
export type MemoryClearArgs = z.infer<typeof MemoryClearArgs>;

export const MemoryClearResult = z.strictObject({
  parsed: z.boolean(),
  rawText: z.string(),
  revision: Revision.nullable(),
  deletedCount: z.number().int().nonnegative(),
});
export type MemoryClearResult = z.infer<typeof MemoryClearResult>;

export const MemoryChanged = z.strictObject({
  folder: FolderPath.nullable(),
  scope: MemoryScope,
  revision: Revision,
  ids: z.array(MemoryId),
  reason: MemoryChangedReason,
});
export type MemoryChanged = z.infer<typeof MemoryChanged>;

export const MemoryStore = definePort({
  name: "A1.memoryStore",
  methods: {
    list: { args: MemoryListArgs, result: MemoryListResult, capability: "host.memory-store" },
    get: { args: MemoryGetArgs, result: MemoryGetResult, capability: "host.memory-store" },
    write: { args: MemoryWriteArgs, result: MemoryWriteResult, capability: "host.memory-store" },
    delete: { args: MemoryDeleteArgs, result: MemoryDeleteResult, capability: "host.memory-store" },
    clear: { args: MemoryClearArgs, result: MemoryClearResult, capability: "host.memory-store" },
  },
  events: {
    changed: { payload: MemoryChanged, capability: "host.memory-store" },
  },
});
