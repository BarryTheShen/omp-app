import { z } from "zod";
import { definePort } from "../../core/envelope";
import { AttachmentRef } from "./draft-store";

/** 1 MiB physical app frame minus JSON/base64 overhead; U2.3's source default is 10 MiB. */
export const MAX_ATTACHMENT_BYTES = 700 * 1024;

export const AttachmentBlobPutArgs = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  mediaType: z.string().min(1).max(128),
  /** Base64 bytes; the server enforces MAX_ATTACHMENT_BYTES after decoding. */
  bytes: z.string().min(1).max(2_000_000),
});
export type AttachmentBlobPutArgs = z.infer<typeof AttachmentBlobPutArgs>;

export const AttachmentBlobPutResult = z.strictObject({
  ref: AttachmentRef,
});
export type AttachmentBlobPutResult = z.infer<typeof AttachmentBlobPutResult>;

export const AttachmentBlobGetArgs = z.strictObject({ ref: AttachmentRef });
export type AttachmentBlobGetArgs = z.infer<typeof AttachmentBlobGetArgs>;

export const AttachmentBlobGetResult = z.strictObject({
  ref: AttachmentRef,
  bytes: z.string().min(1).max(2_000_000),
});
export type AttachmentBlobGetResult = z.infer<typeof AttachmentBlobGetResult>;

export const AttachmentBlobDeleteArgs = z.strictObject({ ref: AttachmentRef });
export type AttachmentBlobDeleteArgs = z.infer<typeof AttachmentBlobDeleteArgs>;

export const AttachmentBlobDeleteResult = z.strictObject({ deleted: z.literal(true) });
export type AttachmentBlobDeleteResult = z.infer<typeof AttachmentBlobDeleteResult>;

export const AttachmentBlobListResult = z.strictObject({ refs: z.array(AttachmentRef) });
export type AttachmentBlobListResult = z.infer<typeof AttachmentBlobListResult>;

export const AttachmentBlobStore = definePort({
  name: "A1.attachmentStore",
  methods: {
    put: {
      args: AttachmentBlobPutArgs,
      result: AttachmentBlobPutResult,
      capability: "host.attachments",
    },
    get: {
      args: AttachmentBlobGetArgs,
      result: AttachmentBlobGetResult,
      capability: "host.attachments",
    },
    delete: {
      args: AttachmentBlobDeleteArgs,
      result: AttachmentBlobDeleteResult,
      capability: "host.attachments",
    },
    list: {
      args: z.strictObject({}),
      result: AttachmentBlobListResult,
      capability: "host.attachments",
    },
  },
  events: {},
});
