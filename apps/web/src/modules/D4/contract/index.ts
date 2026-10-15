import type {
  PersistedMessageKey,
  SessionImportResult as SessionImportResultValue,
} from "@omp-app/contracts";
import {
  DumpScope,
  SessionImportResult as SessionImportResultSchema,
  ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import type { RawTranscriptPart } from "@/modules/U1/copy";

/**
 * C0's persisted message key, `entry:<thread>:<entry>` (`PersistedMessageKey`). Provisional `stream:`
 * keys are not copy targets.
 */
const MessageKeySchema: z.ZodType<PersistedMessageKey> = z.templateLiteral([
  "entry:",
  z.string(),
  ":",
  z.string(),
]);
const PartIndexSchema = z.number().int().nonnegative();
const PositiveCountSchema = z.number().int().positive();
const TextRangeShape = {
  start: PartIndexSchema,
  end: PartIndexSchema,
};
const TextRangeSchema = z.strictObject(TextRangeShape).superRefine((value, context) => {
  if (value.end < value.start) {
    context.addIssue({ code: "custom", message: "range end must not precede range start" });
  }
});
const FencedBlockShape = {
  blockIndex: PartIndexSchema.optional(),
  range: TextRangeSchema.optional(),
};

/**
 * A copy target names a persisted message and one of U1.7's raw parts by its `index`. A whole part
 * (a bash command, a bash output, a code part) needs nothing more; a fenced block inside a text part
 * adds `blockIndex` or `range`.
 */
const PartTargetShape = {
  messageKey: MessageKeySchema,
  partIndex: PartIndexSchema,
  ...FencedBlockShape,
};
export const TranscriptCopyTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), messageKey: MessageKeySchema }),
  z.strictObject({ kind: z.literal("code"), ...PartTargetShape }),
  z.strictObject({ kind: z.literal("command"), ...PartTargetShape }),
]);
export type TranscriptCopyTarget = z.infer<typeof TranscriptCopyTargetSchema>;

/** Human-readable target label and a bounded preview derived from U1's raw per-part records. */
export const TranscriptCopyTargetOptionSchema = z.strictObject({
  target: TranscriptCopyTargetSchema,
  label: z.string().min(1),
  preview: z.string().max(512),
});
export type TranscriptCopyTargetOption = z.infer<typeof TranscriptCopyTargetOptionSchema>;

export const TranscriptCopyResultSchema = z.strictObject({ chars: PositiveCountSchema });
export type TranscriptCopyResult = z.infer<typeof TranscriptCopyResultSchema>;

/**
 * D4 consumes U1.7's per-part records. It never reads RawTranscriptContent.markdown or rendered
 * DOM text; a code/command target's partIndex addresses RawTranscriptPart.index.
 */
export interface TranscriptActionPort {
  getCopyTargets(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): Promise<readonly TranscriptCopyTargetOption[]>;
  readParts(
    target: TranscriptCopyTarget,
    signal?: AbortSignal,
  ): Promise<readonly RawTranscriptPart[]>;
  copy(target: TranscriptCopyTarget, signal?: AbortSignal): Promise<TranscriptCopyResult>;
}

/** Injected browser/desktop clipboard capability; failures reject and callers retain source text. */
export interface ClipboardPort {
  writeText(text: string): Promise<void>;
}

const MessageCopyTargetSchema = z.strictObject({
  kind: z.literal("message"),
  messageKey: MessageKeySchema,
});

const OutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !/(^|[\\/])\.\.([\\/]|$)/.test(value), {
    message: "output path must not contain a parent-directory segment",
  });

export const ExportRequestSchema = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("markdown"),
    threadId: ThreadId,
    target: MessageCopyTargetSchema.optional(),
  }),
  z.strictObject({
    format: z.literal("plain"),
    threadId: ThreadId,
    target: MessageCopyTargetSchema.optional(),
  }),
  z.strictObject({
    format: z.literal("html"),
    threadId: ThreadId,
    outputPath: OutputPathSchema.optional(),
  }),
  z.strictObject({
    format: z.literal("dump"),
    threadId: ThreadId,
    scope: DumpScope,
  }),
]);
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

const ExportDownloadSchema = z.strictObject({
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  content: z.string(),
});

/**
 * The typed result of an export. Markdown and plain downloads are built from U1.7's raw parts; the
 * HTML path comes from A0.8's `export_html`; `/dump` text comes from A1's typed parser (A1 issue 793).
 */
export const ExportResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("download"),
    format: z.enum(["markdown", "plain"]),
    source: z.literal("transcript"),
    download: ExportDownloadSchema,
  }),
  z.strictObject({
    kind: z.literal("path"),
    format: z.literal("html"),
    source: z.literal("omp"),
    path: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("report"),
    format: z.literal("dump"),
    source: z.literal("omp"),
    text: z.string(),
  }),
]);
export type ExportResult = z.infer<typeof ExportResultSchema>;

/**
 * One port for every export, `/dump` included. `/dump` and `/dump all` go through A1's typed parser
 * (A1 issue 793), built on the A1.8 gateway; HTML export is the typed A0 `export_html` command.
 */
export interface ExportPort {
  export(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
}

const HttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"), "share URLs must use HTTPS");

/** The exact one-shot `/share` result; there is no visibility or revoke input on omp 18.6.1. */
export const ShareResultSchema = z.strictObject({
  url: HttpsUrlSchema,
  gistUrl: HttpsUrlSchema.optional(),
  truncated: z.boolean(),
});
export type ShareResult = z.infer<typeof ShareResultSchema>;

/** omp 18.6.1 cannot change share visibility; represent only the verified unavailable state. */
export const ShareVisibilitySchema = z.strictObject({
  state: z.literal("unavailable"),
  capability: z.literal("upstream.share-visibility"),
  reason: z.string().min(1),
});
export type ShareVisibility = z.infer<typeof ShareVisibilitySchema>;

/**
 * `/share` through A1's typed parser (A1 issue 793), built on the A1.8 gateway. An unrecognized shape
 * is an `internal` AppFailure, never a best-effort guess; browser code never receives command-output
 * prose.
 */
export interface SharePort {
  createShare(threadId: ThreadId, signal?: AbortSignal): Promise<ShareResult>;
}

/**
 * Browser-safe projection of A1.12's result for an omp-share import. Session file paths and the
 * source share URL are intentionally omitted. Warnings pass through as A1.12 wrote them; its schema
 * already caps them at 32 items of 512 characters each.
 */
export const ShareImportResultDtoSchema = z.strictObject({
  threadId: ThreadId,
  title: z.string().min(1).optional(),
  artifactStatus: z.enum(["preserved", "unavailable"]),
  artifactWarnings: z.array(z.string().min(1).max(512)).max(32),
});

/** Removes A1.12's file path and source URL while accepting the real port result shape. */
export function toShareImportResultDto(result: SessionImportResultValue): ShareImportResultDto {
  return {
    threadId: result.threadId,
    ...(result.title ? { title: result.title } : {}),
    artifactStatus: result.artifactStatus,
    artifactWarnings: result.artifactWarnings,
  };
}

export function parseShareImportResult(value: unknown): ShareImportResultDto {
  return toShareImportResultDto(SessionImportResultSchema.parse(value));
}
export type ShareImportResultDto = z.infer<typeof ShareImportResultDtoSchema>;
