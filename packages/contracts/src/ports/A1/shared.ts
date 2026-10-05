import { z } from "zod";
import { EntryId, FolderPath, SessionFilePath, ThreadId } from "../../core/ids";
import { Provenance, SettingSource } from "../../core/provenance";

/** JSON values used by the app wire for non-secret settings and parser metadata. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

/** Opaque, non-empty revision/CAS token returned by a server-owned store. */
export const Revision = z.string().min(1).max(512);
export type Revision = z.infer<typeof Revision>;

/** Opaque paging cursor. It is never interpreted by a browser consumer. */
export const Cursor = z.string().min(1).max(512);
export type Cursor = z.infer<typeof Cursor>;

/** Store timestamps are ISO strings in implementations, but parsers remain tolerant of old files. */
export const Timestamp = z.string().min(1);
export type Timestamp = z.infer<typeof Timestamp>;

/** Relative or absolute path text after the server has applied its workspace policy. */
export const PathText = z
  .string()
  .min(1)
  .refine((path) => !path.includes("\0"), "path must not contain NUL");
export type PathText = z.infer<typeof PathText>;

export const SettingSourceList = z.array(SettingSource);

/** A setting value with its effective omp layer and lower-precedence configured layers. */
export const SourcedSetting = <Value extends z.ZodType>(value: Value) =>
  z.object({
    value,
    source: SettingSource,
    overrides: SettingSourceList,
    provenance: Provenance.optional(),
  });

export const ConfigWriteLayer = z.enum(["global", "project", "app"]);
export type ConfigWriteLayer = z.infer<typeof ConfigWriteLayer>;

/** Scope shared by app-owned per-thread and per-folder stores. */
export const DraftScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
  z.object({ kind: z.literal("folder"), folder: FolderPath }),
]);
export type DraftScope = z.infer<typeof DraftScope>;

/** The conversation point associated with a workspace snapshot. */
export const ConversationHead = z.object({
  threadId: ThreadId,
  sessionFile: SessionFilePath.nullable(),
  entryId: EntryId.nullable(),
});
export type ConversationHead = z.infer<typeof ConversationHead>;

export const SnapshotGuarantee = z.enum(["boundary", "exact"]);
export type SnapshotGuarantee = z.infer<typeof SnapshotGuarantee>;

export const RestoreOperation = z.enum([
  "files-only",
  "conversation-only",
  "both",
  "redo",
  "edit-resend",
]);
export type RestoreOperation = z.infer<typeof RestoreOperation>;
