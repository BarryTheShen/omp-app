import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

const UnknownRecord = z.record(z.string(), z.unknown());
const OptionalText = z.string().optional();

export const OutputRangeSchema = z.looseObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});
export type OutputRange = z.infer<typeof OutputRangeSchema>;

export const TruncationMetaSchema = z.looseObject({
  direction: z.enum(["head", "tail", "middle"]),
  reason: z.enum(["lines", "bytes", "middle"]),
  totalLines: z.int().nonnegative().optional(),
  shownLines: z.int().nonnegative().optional(),
  totalBytes: z.int().nonnegative().optional(),
  shownBytes: z.int().nonnegative().optional(),
  shownHead: OutputRangeSchema.optional(),
  shownTail: OutputRangeSchema.optional(),
  omittedLines: z.int().nonnegative().optional(),
  omittedBytes: z.int().nonnegative().optional(),
  artifactId: z.string().min(1).optional(),
  artifactElidedBytes: z.int().nonnegative().optional(),
  offset: z.int().nonnegative().optional(),
  partialLine: z.boolean().optional(),
});
export type TruncationMeta = z.infer<typeof TruncationMetaSchema>;

export const OutputMetaSchema = z.looseObject({
  truncation: TruncationMetaSchema.optional(),
  source: z.string().optional(),
  artifactId: z.string().min(1).optional(),
  artifactElidedBytes: z.int().nonnegative().optional(),
  artifactError: UnknownRecord.optional(),
  diagnostics: z.array(z.unknown()).optional(),
  limits: z.array(z.unknown()).optional(),
});
export type OutputMeta = z.infer<typeof OutputMetaSchema>;

export const DiagnosticSchema = z.looseObject({
  severity: z.enum(["error", "warning", "info", "hint"]).optional(),
  message: z.string().optional(),
  path: z.string().optional(),
  line: z.int().positive().optional(),
  column: z.int().positive().optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const ArtifactNoticeSchema = z.looseObject({
  artifactId: z.string().min(1),
  artifactElidedBytes: z.int().nonnegative().optional(),
  artifactError: UnknownRecord.optional(),
});
export type ArtifactNotice = z.infer<typeof ArtifactNoticeSchema>;

export const ReadToolArgsSchema = z
  .looseObject({
    path: OptionalText,
    file_path: OptionalText,
    offset: z.int().nonnegative().optional(),
    limit: z.int().positive().optional(),
    raw: z.boolean().optional(),
  })
  .refine(
    (args) => args.path !== undefined || args.file_path !== undefined,
    "read path is required",
  );
export type ReadToolArgs = z.infer<typeof ReadToolArgsSchema>;

export const ReadDisplayContentSchema = z.looseObject({
  text: z.string(),
  startLine: z.int().nonnegative().optional(),
  lineNumbers: z.boolean().optional(),
});
export type ReadDisplayContent = z.infer<typeof ReadDisplayContentSchema>;

export const ReadToolDetailsSchema = z.looseObject({
  kind: z.enum(["file", "url"]).optional(),
  displayTarget: z.string().optional(),
  truncation: TruncationMetaSchema.optional(),
  isDirectory: z.boolean().optional(),
  resolvedPath: z.string().optional(),
  suffixResolution: z.string().optional(),
  url: z.string().optional(),
  finalUrl: z.string().optional(),
  contentType: z.string().optional(),
  method: z.string().optional(),
  notes: z.array(z.string()).optional(),
  meta: OutputMetaSchema.optional(),
  fileSize: z.number().nonnegative().optional(),
  totalLines: z.int().nonnegative().optional(),
  displayContent: ReadDisplayContentSchema.optional(),
  summary: z.string().optional(),
  conflictCount: z.int().nonnegative().optional(),
  displayReadTargets: z.array(z.string()).optional(),
  displayReadTargetLinks: z.array(z.string()).optional(),
});
export type ReadToolDetails = z.infer<typeof ReadToolDetailsSchema>;

export const WriteToolArgsSchema = z
  .looseObject({
    path: OptionalText,
    file_path: OptionalText,
    content: z.string().optional(),
  })
  .refine(
    (args) => args.path !== undefined || args.file_path !== undefined,
    "write path is required",
  )
  .refine((args) => args.content !== undefined, "write content is required");
export type WriteToolArgs = z.infer<typeof WriteToolArgsSchema>;

export const WriteToolDetailsSchema = z.looseObject({
  diagnostics: z.array(DiagnosticSchema).optional(),
  meta: OutputMetaSchema.optional(),
  madeExecutable: z.boolean().optional(),
  resolvedPath: z.string().optional(),
  xdev: z.boolean().optional(),
  message: z.string().optional(),
  proc: UnknownRecord.optional(),
  cfg: UnknownRecord.optional(),
});
export type WriteToolDetails = z.infer<typeof WriteToolDetailsSchema>;

export const EditToolArgsSchema = z.looseObject({
  path: OptionalText,
  file_path: OptionalText,
  oldText: z.string().optional(),
  newText: z.string().optional(),
  patch: z.string().optional(),
  input: z.string().optional(),
  replace_all: z.boolean().optional(),
  op: z.string().optional(),
  rename: z.string().optional(),
  diff: z.string().optional(),
  previewDiff: z.string().optional(),
  edits: z.array(UnknownRecord).optional(),
});
export type EditToolArgs = z.infer<typeof EditToolArgsSchema>;

export const EditPerFileResultSchema = z.looseObject({
  path: z.string().optional(),
  diff: z.string().optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  op: z.enum(["create", "delete", "update"]).optional(),
  move: UnknownRecord.optional(),
  error: z.string().optional(),
  meta: OutputMetaSchema.optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
});
export type EditPerFileResult = z.infer<typeof EditPerFileResultSchema>;

export const EditToolDetailsSchema = z.looseObject({
  diff: z.string().optional(),
  firstChangedLine: z.int().positive().optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  op: z.enum(["create", "delete", "update"]).optional(),
  move: UnknownRecord.optional(),
  meta: OutputMetaSchema.optional(),
  perFileResults: z.array(EditPerFileResultSchema).optional(),
  path: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  snapshotsPruned: z.boolean().optional(),
  sourcePath: z.string().optional(),
});
export type EditToolDetails = z.infer<typeof EditToolDetailsSchema>;

export const AstEditToolArgsSchema = z.looseObject({
  ops: z.array(
    z.looseObject({
      pat: z.string(),
      out: z.string(),
    }),
  ),
  paths: z.array(z.string()),
});
export type AstEditToolArgs = z.infer<typeof AstEditToolArgsSchema>;

export const AstEditToolDetailsSchema = z.looseObject({
  totalReplacements: z.int().nonnegative().optional(),
  filesTouched: z.int().nonnegative().optional(),
  filesSearched: z.int().nonnegative().optional(),
  applied: z.boolean().optional(),
  limitReached: z.boolean().optional(),
  parseErrors: z.array(UnknownRecord).optional(),
  parseErrorsTotal: z.int().nonnegative().optional(),
  scopePath: z.string().optional(),
  files: z.array(z.string()).optional(),
  fileReplacements: z.array(UnknownRecord).optional(),
  meta: OutputMetaSchema.optional(),
  displayContent: z.string().optional(),
  searchPath: z.string().optional(),
  cwd: z.string().optional(),
});
export type AstEditToolDetails = z.infer<typeof AstEditToolDetailsSchema>;

export type DetailDecode<T> =
  | { readonly ok: true; readonly value: T; readonly raw: unknown }
  | { readonly ok: false; readonly error: AppFailure; readonly raw: unknown };

export function decodeReadArgs(value: unknown): DetailDecode<ReadToolArgs> {
  return decode(ReadToolArgsSchema, value, "read arguments");
}
export function decodeReadDetails(value: unknown): DetailDecode<ReadToolDetails> {
  return decode(ReadToolDetailsSchema, value, "read details");
}
export function decodeWriteArgs(value: unknown): DetailDecode<WriteToolArgs> {
  return decode(WriteToolArgsSchema, value, "write arguments");
}
export function decodeWriteDetails(value: unknown): DetailDecode<WriteToolDetails> {
  return decode(WriteToolDetailsSchema, value, "write details");
}
export function decodeEditArgs(value: unknown): DetailDecode<EditToolArgs> {
  return decode(EditToolArgsSchema, value, "edit arguments");
}
export function decodeEditDetails(value: unknown): DetailDecode<EditToolDetails> {
  return decode(EditToolDetailsSchema, value, "edit details");
}
export function decodeAstEditArgs(value: unknown): DetailDecode<AstEditToolArgs> {
  return decode(AstEditToolArgsSchema, value, "ast_edit arguments");
}
export function decodeAstEditDetails(value: unknown): DetailDecode<AstEditToolDetails> {
  return decode(AstEditToolDetailsSchema, value, "ast_edit details");
}

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): DetailDecode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    error: new AppFailure({
      code: "invalid_args",
      message: `Malformed ${label}; showing the raw tool result.`,
      retryable: false,
    }),
    raw,
  };
}
