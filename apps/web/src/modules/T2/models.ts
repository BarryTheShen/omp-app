import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import { OutputMetaSchema as SharedOutputMetaSchema } from "../U3/tool-card/output-meta";

/**
 * The shared output meta plus `total`, which the grep card reads for 'Showing N of M matches'. omp
 * v18.6.1's grep never sends it (its details carry `matchCount` and `truncated`), so that text
 * cannot appear on a real result; tracked in the tool cards parent issue (712).
 */
export const OutputMetaSchema = SharedOutputMetaSchema.extend({
  total: z.number().int().nonnegative().optional(),
});
export type OutputMeta = z.infer<typeof OutputMetaSchema>;

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
  fileLimitReached: z.number().int().nonnegative().optional(),
  perFileLimitReached: z.number().int().nonnegative().optional(),
  linesTruncated: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  scopePath: OptionalText,
  matchCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  files: z.array(z.string()).optional(),
  fileMatches: z.array(GrepFileMatchSchema).optional(),
  truncated: z.boolean().optional(),
  error: OptionalText,
  displayContent: OptionalText,
  displayTargets: z.record(z.string(), z.string()).optional(),
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
  resultLimitReached: z
    .number()
    .int()
    .nonnegative()
    .transform((count) => count > 0)
    .optional(),
  meta: OutputMetaSchema.optional(),
  scopePath: OptionalText,
  fileCount: z.number().int().nonnegative().optional(),
  files: z.array(z.string().min(1)).optional(),
  truncated: z.boolean().optional(),
  /**
   * The scan hit the tool's deadline, so the files listed are an incomplete set (packages/tui/src/tools/glob.ts:38-41,
   * set at packages/coding-agent/src/tools/glob.ts:316,347). Such a result also has `truncated: true`.
   */
  timedOut: z.boolean().optional(),
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

/**
 * omp v18.6.1 `FindRange`/`FindHit`/`FindStats` (packages/tui/src/tools/find.ts:39-80, filled by
 * packages/coding-agent/src/tools/jfind/cascade.ts:110-125). `p` is the range's verified
 * probability; `failures` lists distinct phase-prefixed request failure messages.
 */
export const FindRangeSchema = OutputRangeSchema.extend({
  p: OptionalNumber,
});
export type FindRange = z.infer<typeof FindRangeSchema>;

export const FindHitSchema = z.looseObject({
  rel: OptionalText,
  path: OptionalText,
  nameScore: OptionalNumber,
  contentScore: OptionalNumber,
  score: OptionalNumber,
  ranges: z.array(FindRangeSchema).optional(),
  linesSeen: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  snippet: OptionalText,
});
export type FindHit = z.infer<typeof FindHitSchema>;

/**
 * omp v18.12.6 `FindStats` (packages/tui/src/tools/find.ts:72-97): `failed` counts judge requests that failed
 * outright and decides the search's coverage; `unanswered` counts questions a successful response left without an
 * answer. v18.9.1 had one `errors` count for both.
 */
export const FindStatsSchema = z.looseObject({
  listed: z.number().int().nonnegative().optional(),
  requests: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  unanswered: z.number().int().nonnegative().optional(),
  judged: z.number().int().nonnegative().optional(),
  filesRead: z.number().int().nonnegative().optional(),
  fileBytes: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cost: OptionalNumber,
  apiMs: OptionalNumber,
  windowsJudged: z.number().int().nonnegative().optional(),
  windowsPruned: z.number().int().nonnegative().optional(),
  mapCards: z.number().int().nonnegative().optional(),
  failures: z.array(z.string()).optional(),
});
export type FindStats = z.infer<typeof FindStatsSchema>;

export const FindToolDetailsSchema = z.looseObject({
  query: OptionalText,
  keywords: z.array(z.string()).optional(),
  threshold: OptionalNumber,
  hits: z.array(FindHitSchema).optional(),
  /**
   * How much of the search the judge covered (packages/tui/src/tools/find.ts:64-70, set at
   * packages/coding-agent/src/tools/jfind/cascade.ts:357-359): "complete", "partial" (some requests failed, unjudged
   * files may still match) or "unavailable" (every request failed; omp returns that as an error).
   */
  coverage: z.string().optional(),
  stats: FindStatsSchema.optional(),
  elapsedMs: OptionalNumber,
  cwd: OptionalText,
  scopePath: OptionalText,
  meta: OutputMetaSchema.optional(),
  error: OptionalText,
  raw: OptionalText,
});
export type FindToolDetails = z.infer<typeof FindToolDetailsSchema>;

/** omp v18.6.1 `ast_grep` parameters (packages/coding-agent/src/tools/ast-grep.ts:33-40). */
export const AstGrepToolArgsSchema = z.looseObject({
  pat: z.string(),
  path: OptionalText,
  lang: OptionalText,
  skip: z.number().int().nonnegative().optional(),
});
export type AstGrepToolArgs = z.infer<typeof AstGrepToolArgsSchema>;

/**
 * omp v18.6.1 `AstGrepToolDetails` (packages/tui/src/tools/ast-grep.ts:24-45, filled by
 * packages/coding-agent/src/tools/ast-grep.ts:260-352). `displayContent` is omp's grouped
 * display text: `# dir/` and `## file` headers, then `*12│code` rows where `*` marks a match.
 */
export const AstGrepToolDetailsSchema = z.looseObject({
  matchCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  filesSearched: z.number().int().nonnegative().optional(),
  limitReached: z.boolean().optional(),
  parseErrors: z.array(z.string()).optional(),
  parseErrorsTotal: z.number().int().nonnegative().optional(),
  scopePath: OptionalText,
  files: z.array(z.string()).optional(),
  fileMatches: z
    .array(z.looseObject({ path: z.string(), count: z.number().int().nonnegative() }))
    .optional(),
  meta: OutputMetaSchema.optional(),
  displayContent: OptionalText,
  searchPath: OptionalText,
  cwd: OptionalText,
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
  timeout: z.number().positive().optional(),
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

/**
 * omp v18.6.1 `LspToolDetails` (packages/tui/src/tools/lsp.ts:67-72). Every action's answer is
 * the result's text content (packages/coding-agent/src/lsp/tool.ts:1537-1541); details carry
 * only the action, server, success flag and the request.
 */
export const LspToolDetailsSchema = z.looseObject({
  serverName: OptionalText,
  action: OptionalText,
  success: z.boolean().optional(),
  request: UnknownRecord.optional(),
});
export type LspToolDetails = z.infer<typeof LspToolDetailsSchema>;

/**
 * One file in omp's late diagnostics message (`details.files[]`, packages/coding-agent/src/sdk.ts:414-446 at
 * v18.8.9): its path, omp's summary (for example "1 error(s)"), whether it errored, and omp's diagnostic lines as text.
 * The lines are omp's human text, so the browser shows them as written and never splits them (AP4).
 */
export const LateDiagnosticFileSchema = z.looseObject({
  path: z.string(),
  summary: z.string(),
  errored: z.boolean(),
  messages: z.array(z.string()),
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
