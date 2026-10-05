import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { Timestamp } from "./shared";

export const PLAN_DOCUMENT_STATUSES = [
  "draft",
  "review",
  "approved",
  "rejected",
  "executing",
  "complete",
] as const;
export const PlanDocumentStatus = z.enum(PLAN_DOCUMENT_STATUSES);
export type PlanDocumentStatus = z.infer<typeof PlanDocumentStatus>;

export const PlanDocumentId = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => !id.includes("\0"));
export type PlanDocumentId = z.infer<typeof PlanDocumentId>;

export const PlanSection = z.strictObject({
  id: z.string().min(1).max(256),
  heading: z.string().min(1).max(512),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});
export type PlanSection = z.infer<typeof PlanSection>;

export const PlanAnnotation = z.strictObject({
  id: z.string().min(1).max(256),
  sectionId: z.string().min(1).max(256),
  line: z.int().nonnegative().optional(),
  text: z.string().max(32_000),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PlanAnnotation = z.infer<typeof PlanAnnotation>;

export const PlanDocumentInput = z.strictObject({
  id: PlanDocumentId,
  threadId: ThreadId,
  markdown: z.string().max(1_000_000),
  sections: z.array(PlanSection).max(2_000),
  annotations: z.array(PlanAnnotation).max(2_000),
  status: PlanDocumentStatus,
});
export type PlanDocumentInput = z.infer<typeof PlanDocumentInput>;

export const PlanDocument = PlanDocumentInput.extend({
  revision: z.int().positive(),
  updatedAt: Timestamp,
});
export type PlanDocument = z.infer<typeof PlanDocument>;

/** One bounded previous document snapshot; the current document is in `PlanDocument`. */
export const PlanRevision = z.strictObject({
  revision: z.int().positive(),
  savedAt: Timestamp,
  markdown: z.string().max(1_000_000),
  sections: z.array(PlanSection).max(2_000),
  annotations: z.array(PlanAnnotation).max(2_000),
  status: PlanDocumentStatus,
});
export type PlanRevision = z.infer<typeof PlanRevision>;

export const PlanLoadArgs = z.strictObject({ threadId: ThreadId });
export type PlanLoadArgs = z.infer<typeof PlanLoadArgs>;

export const PlanLoadResult = z.strictObject({
  document: PlanDocument.nullable(),
  revisions: z.array(PlanRevision).max(50),
});
export type PlanLoadResult = z.infer<typeof PlanLoadResult>;

export const PlanSaveArgs = z.strictObject({
  document: PlanDocumentInput,
  /** The browser's last loaded revision; stale saves are a plain `conflict` AppFailure. */
  expectedRevision: z.int().nonnegative(),
});
export type PlanSaveArgs = z.infer<typeof PlanSaveArgs>;

export const PlanSaveResult = PlanLoadResult;
export type PlanSaveResult = z.infer<typeof PlanSaveResult>;

export const PlanExportArgs = z.strictObject({
  documentId: PlanDocumentId,
  format: z.enum(["markdown", "json"]),
});
export type PlanExportArgs = z.infer<typeof PlanExportArgs>;

export const PlanExportResult = z.strictObject({
  documentId: PlanDocumentId,
  format: z.enum(["markdown", "json"]),
  text: z.string(),
});
export type PlanExportResult = z.infer<typeof PlanExportResult>;

export const PlanChanged = z.strictObject({
  threadId: ThreadId,
  document: PlanDocument,
  revisions: z.array(PlanRevision).max(50),
});
export type PlanChanged = z.infer<typeof PlanChanged>;

export const PlanDocumentStore = definePort({
  name: "A1.planDocumentStore",
  methods: {
    load: {
      args: PlanLoadArgs,
      result: PlanLoadResult,
      capability: "host.plan-documents",
    },
    save: {
      args: PlanSaveArgs,
      result: PlanSaveResult,
      capability: "host.plan-documents",
    },
    export: {
      args: PlanExportArgs,
      result: PlanExportResult,
      capability: "host.plan-documents",
    },
  },
  events: {
    changed: {
      payload: PlanChanged,
      capability: "host.plan-documents",
    },
  },
});
