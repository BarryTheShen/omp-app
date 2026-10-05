import { z } from "zod";
import { definePort } from "../../core/envelope";
import { DraftScope, PathText, Revision, Timestamp } from "./shared";

/** A durable reference to an attachment; binary contents never travel through this store. */
export const AttachmentRef = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.int().nonnegative().optional(),
  uri: PathText.optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const FailedSend = z.strictObject({
  attemptedAt: Timestamp,
  text: z.string(),
  attachments: z.array(AttachmentRef),
  reason: z.string().min(1),
});
export type FailedSend = z.infer<typeof FailedSend>;

export const Draft = z.strictObject({
  scope: DraftScope,
  text: z.string(),
  attachments: z.array(AttachmentRef),
  failedSends: z.array(FailedSend),
  revision: Revision,
  updatedAt: Timestamp,
});
export type Draft = z.infer<typeof Draft>;

export const DraftInput = z.strictObject({
  text: z.string(),
  attachments: z.array(AttachmentRef),
  failedSends: z.array(FailedSend),
});
export type DraftInput = z.infer<typeof DraftInput>;

export const DraftGetArgs = z.strictObject({ scope: DraftScope });
export type DraftGetArgs = z.infer<typeof DraftGetArgs>;

export const DraftGetResult = z.strictObject({ draft: Draft.nullable() });
export type DraftGetResult = z.infer<typeof DraftGetResult>;

export const DraftSaveArgs = z.strictObject({
  scope: DraftScope,
  draft: DraftInput,
  /** `null` means no draft exists yet; writes are compare-and-swap. */
  expectedRevision: Revision.nullable(),
});
export type DraftSaveArgs = z.infer<typeof DraftSaveArgs>;

export const DraftClearArgs = z.strictObject({
  scope: DraftScope,
  expectedRevision: Revision.nullable(),
});
export type DraftClearArgs = z.infer<typeof DraftClearArgs>;

export const DraftClearResult = z.strictObject({
  cleared: z.boolean(),
  revision: Revision.nullable(),
});
export type DraftClearResult = z.infer<typeof DraftClearResult>;

export const DraftChanged = z.strictObject({
  scope: DraftScope,
  draft: Draft.nullable(),
});
export type DraftChanged = z.infer<typeof DraftChanged>;

export const DraftStore = definePort({
  name: "A1.draftStore",
  methods: {
    get: {
      args: DraftGetArgs,
      result: DraftGetResult,
      capability: "host.drafts",
    },
    save: {
      args: DraftSaveArgs,
      result: Draft,
      capability: "host.drafts",
    },
    clear: {
      args: DraftClearArgs,
      result: DraftClearResult,
      capability: "host.drafts",
    },
  },
  events: {
    changed: {
      payload: DraftChanged,
      capability: "host.drafts",
    },
  },
});
