import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

const OptionalText = z.string().optional();
const OptionalNumber = z.number().finite().optional();
const UnknownRecord = z.record(z.string(), z.unknown());

export type DetailDecode<T> =
  | { readonly ok: true; readonly value: T; readonly raw: unknown }
  | { readonly ok: false; readonly error: AppFailure; readonly raw: unknown };

export const OutputRangeSchema = z.looseObject({
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  snippet: OptionalText,
});
export type OutputRange = z.infer<typeof OutputRangeSchema>;

export const OutputMetaSchema = z.looseObject({
  truncation: z
    .looseObject({
      direction: z.enum(["head", "tail", "middle"]).optional(),
      reason: z.string().optional(),
      omitted: z.number().int().nonnegative().optional(),
    })
    .optional(),
  total: z.number().int().nonnegative().optional(),
  artifactId: OptionalText,
  source: OptionalText,
  diagnostics: z.array(z.unknown()).optional(),
  limits: UnknownRecord.optional(),
});
export type OutputMeta = z.infer<typeof OutputMetaSchema>;

export const PathLinkSchema = z.looseObject({
  path: z.string().optional(),
  target: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
});
export type PathLink = z.infer<typeof PathLinkSchema>;

export const GrepToolArgsSchema = z.looseObject({
  pattern: z.string(),
  path: OptionalText,
  case: z.boolean().optional(),
  gitignore: z.boolean().optional(),
  skip: z.number().int().nonnegative().optional(),
});
export type GrepToolArgs = z.infer<typeof GrepToolArgsSchema>;

export const GrepFileMatchSchema = z.looseObject({
  path: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  matches: z.array(OutputRangeSchema).optional(),
  snippets: z.array(OutputRangeSchema).optional(),
});
export type GrepFileMatch = z.infer<typeof GrepFileMatchSchema>;

export const GrepToolDetailsSchema = z.looseObject({
  truncation: OutputMetaSchema.shape.truncation,
  fileLimitReached: z.boolean().optional(),
  perFileLimitReached: z.boolean().optional(),
  linesTruncated: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  scopePath: OptionalText,
  matchCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  files: z.array(PathLinkSchema).optional(),
  fileMatches: z.array(GrepFileMatchSchema).optional(),
  truncated: z.boolean().optional(),
  error: OptionalText,
  displayContent: OptionalText,
  displayTargets: z.array(PathLinkSchema).optional(),
  searchPath: OptionalText,
  cwd: OptionalText,
  missingPaths: z.array(z.string()).optional(),
  raw: OptionalText,
});
export type GrepToolDetails = z.infer<typeof GrepToolDetailsSchema>;

export const GlobToolArgsSchema = z.looseObject({
  path: OptionalText,
  hidden: z.boolean().optional(),
  gitignore: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});
export type GlobToolArgs = z.infer<typeof GlobToolArgsSchema>;

export const GlobToolDetailsSchema = z.looseObject({
  truncation: OutputMetaSchema.shape.truncation,
  resultLimitReached: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  scopePath: OptionalText,
  fileCount: z.number().int().nonnegative().optional(),
  files: z.array(PathLinkSchema).optional(),
  truncated: z.boolean().optional(),
  error: OptionalText,
  cwd: OptionalText,
  missingPaths: z.array(z.string()).optional(),
  raw: OptionalText,
});
export type GlobToolDetails = z.infer<typeof GlobToolDetailsSchema>;

export const FindToolArgsSchema = z.looseObject({
  query: z.string(),
  grep_keywords: z.array(z.string()),
  path: OptionalText,
});
export type FindToolArgs = z.infer<typeof FindToolArgsSchema>;

export const FindHitSchema = z.looseObject({
  rel: OptionalText,
  path: OptionalText,
  nameScore: OptionalNumber,
  contentScore: OptionalNumber,
  score: OptionalNumber,
  ranges: z.array(OutputRangeSchema).optional(),
  linesSeen: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  snippet: OptionalText,
});
export type FindHit = z.infer<typeof FindHitSchema>;

export const FindStatsSchema = z.looseObject({
  listed: z.number().int().nonnegative().optional(),
  requested: z.number().int().nonnegative().optional(),
  errors: z.number().int().nonnegative().optional(),
  judged: z.number().int().nonnegative().optional(),
  filesRead: z.number().int().nonnegative().optional(),
  fileBytes: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  cost: OptionalNumber,
  elapsedMs: OptionalNumber,
  window: UnknownRecord.optional(),
  failures: z.number().int().nonnegative().optional(),
});
export type FindStats = z.infer<typeof FindStatsSchema>;

export const FindToolDetailsSchema = z.looseObject({
  query: OptionalText,
  keywords: z.array(z.string()).optional(),
  threshold: OptionalNumber,
  hits: z.array(FindHitSchema).optional(),
  stats: FindStatsSchema.optional(),
  elapsedMs: OptionalNumber,
  cwd: OptionalText,
  scopePath: OptionalText,
  meta: OutputMetaSchema.optional(),
  error: OptionalText,
  raw: OptionalText,
});
export type FindToolDetails = z.infer<typeof FindToolDetailsSchema>;

export const AstGrepToolArgsSchema = z.looseObject({
  pattern: z.string().optional(),
  path: OptionalText,
  language: OptionalText,
  rewrite: OptionalText,
});
export type AstGrepToolArgs = z.infer<typeof AstGrepToolArgsSchema>;

export const AstGrepToolDetailsSchema = z.looseObject({
  pattern: OptionalText,
  scopePath: OptionalText,
  language: OptionalText,
  matches: z.array(PathLinkSchema).optional(),
  matchCount: z.number().int().nonnegative().optional(),
  files: z.array(PathLinkSchema).optional(),
  parseErrors: z.array(z.string()).optional(),
  limitReached: z.boolean().optional(),
  truncated: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  error: OptionalText,
  raw: OptionalText,
});
export type AstGrepToolDetails = z.infer<typeof AstGrepToolDetailsSchema>;

export const LspToolArgsSchema = z.looseObject({
  action: z.string(),
  file: OptionalText,
  line: z.number().int().nonnegative().optional(),
  symbol: OptionalText,
  query: OptionalText,
  new_name: OptionalText,
  apply: z.boolean().optional(),
  timeout: z.number().int().nonnegative().optional(),
  payload: z.unknown().optional(),
});
export type LspToolArgs = z.infer<typeof LspToolArgsSchema>;

export const LspDiagnosticSchema = z.looseObject({
  severity: z.union([z.string(), z.number()]).optional(),
  message: OptionalText,
  code: z.union([z.string(), z.number()]).optional(),
  source: OptionalText,
  range: OutputRangeSchema.optional(),
});
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;

export const FileFormatResultSchema = z.enum(["unchanged", "formatted", "failed", "unsupported"]);
export type FileFormatResult = z.infer<typeof FileFormatResultSchema>;

export const FileDiagnosticsResultSchema = z.looseObject({
  server: OptionalText,
  messages: z.array(LspDiagnosticSchema).optional(),
  diagnostics: z.array(LspDiagnosticSchema).optional(),
  summary: OptionalText,
  errored: z.boolean().optional(),
  formatter: FileFormatResultSchema.optional(),
});
export type FileDiagnosticsResult = z.infer<typeof FileDiagnosticsResultSchema>;

export const LspToolDetailsSchema = z.looseObject({
  serverName: OptionalText,
  action: OptionalText,
  success: z.boolean().optional(),
  request: UnknownRecord.optional(),
  hover: OptionalText,
  diagnostics: z.array(FileDiagnosticsResultSchema).optional(),
  files: z.array(FileDiagnosticsResultSchema).optional(),
  references: z.array(PathLinkSchema).optional(),
  symbols: z.array(UnknownRecord).optional(),
  result: z.unknown().optional(),
  formatter: FileFormatResultSchema.optional(),
  truncated: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  error: OptionalText,
  raw: OptionalText,
});
export type LspToolDetails = z.infer<typeof LspToolDetailsSchema>;

export const LateDiagnosticFileSchema = z.looseObject({
  path: OptionalText,
  diagnostics: z.array(LspDiagnosticSchema).optional(),
  messages: z.array(LspDiagnosticSchema).optional(),
  summary: OptionalText,
  formatter: FileFormatResultSchema.optional(),
});
export type LateDiagnosticFile = z.infer<typeof LateDiagnosticFileSchema>;

export const LateDiagnosticDetailsSchema = z.looseObject({
  files: z.array(LateDiagnosticFileSchema),
  source: OptionalText,
  raw: OptionalText,
  meta: OutputMetaSchema.optional(),
});
export type LateDiagnosticDetails = z.infer<typeof LateDiagnosticDetailsSchema>;

export const LateDiagnosticMessageSchema = z.looseObject({
  customType: z.literal("lsp-late-diagnostic"),
  toolCallId: OptionalText,
  relatedToolCallId: OptionalText,
  source: z.looseObject({ toolCallId: OptionalText }).optional(),
  details: LateDiagnosticDetailsSchema,
});
export type LateDiagnosticMessage = z.infer<typeof LateDiagnosticMessageSchema>;

export interface LateDiagnosticAdapterSnapshot extends LateDiagnosticMessage {
  readonly attachmentToolCallId: string | undefined;
}

export function decodeGrepArgs(value: unknown): DetailDecode<GrepToolArgs> {
  return decode(GrepToolArgsSchema, value, "grep arguments");
}
export function decodeGrepDetails(value: unknown): DetailDecode<GrepToolDetails> {
  return decode(GrepToolDetailsSchema, value, "grep details");
}
export function decodeGlobArgs(value: unknown): DetailDecode<GlobToolArgs> {
  return decode(GlobToolArgsSchema, value, "glob arguments");
}
export function decodeGlobDetails(value: unknown): DetailDecode<GlobToolDetails> {
  return decode(GlobToolDetailsSchema, value, "glob details");
}
export function decodeFindArgs(value: unknown): DetailDecode<FindToolArgs> {
  return decode(FindToolArgsSchema, value, "semantic find arguments");
}
export function decodeFindDetails(value: unknown): DetailDecode<FindToolDetails> {
  return decode(FindToolDetailsSchema, value, "semantic find details");
}
export function decodeAstGrepArgs(value: unknown): DetailDecode<AstGrepToolArgs> {
  return decode(AstGrepToolArgsSchema, value, "ast_grep arguments");
}
export function decodeAstGrepDetails(value: unknown): DetailDecode<AstGrepToolDetails> {
  return decode(AstGrepToolDetailsSchema, value, "ast_grep details");
}
export function decodeLspArgs(value: unknown): DetailDecode<LspToolArgs> {
  return decode(LspToolArgsSchema, value, "lsp arguments");
}
export function decodeLspDetails(value: unknown): DetailDecode<LspToolDetails> {
  return decode(LspToolDetailsSchema, value, "lsp details");
}
export function decodeLateDiagnostic(value: unknown): DetailDecode<LateDiagnosticAdapterSnapshot> {
  const decoded = decode(LateDiagnosticMessageSchema, value, "late LSP diagnostic message");
  if (!decoded.ok) return decoded;
  const attachmentToolCallId =
    decoded.value.toolCallId ?? decoded.value.relatedToolCallId ?? decoded.value.source?.toolCallId;
  return { ok: true, value: { ...decoded.value, attachmentToolCallId }, raw: decoded.raw };
}

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): DetailDecode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    error: new AppFailure({
      code: "invalid_args",
      message: `The ${label} payload was malformed`,
      retryable: false,
    }),
    raw,
  };
}
