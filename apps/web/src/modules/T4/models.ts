import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import { ReadToolDetailsSchema } from "../T1/models";
import { OutputMetaSchema } from "../U3/tool-card/output-meta";

const UnknownRecord = z.record(z.string(), z.unknown());

/** T1's normalized URL read details, narrowed without duplicating its read model. */
export const ReadUrlToolDetailsSchema = ReadToolDetailsSchema.extend({ kind: z.literal("url") });
export type ReadUrlToolDetails = z.infer<typeof ReadUrlToolDetailsSchema>;

export const BrowserAction = z.enum(["open", "close", "run", "call", "tabs"]);
export type BrowserAction = z.infer<typeof BrowserAction>;

export const BrowserToolArgsSchema = z.looseObject({
  action: BrowserAction.optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  app: UnknownRecord.optional(),
  viewport: UnknownRecord.optional(),
  wait_until: z.string().optional(),
  dialogs: z.unknown().optional(),
  allowed_domains: z.array(z.string()).optional(),
  init_scripts: z.array(z.string()).optional(),
  downloads: z.unknown().optional(),
  user_agent: z.string().optional(),
  ignore_https_errors: z.boolean().optional(),
  allow_file_access: z.boolean().optional(),
  headed: z.boolean().optional(),
  code: z.string().optional(),
  fn: z.string().optional(),
  args: z.unknown().optional(),
  chain: z.array(UnknownRecord).optional(),
  timeout: z.number().nonnegative().optional(),
  all: z.boolean().optional(),
  kill: z.boolean().optional(),
  persist: z.boolean().optional(),
});
export type BrowserToolArgs = z.infer<typeof BrowserToolArgsSchema>;

export const BrowserObservationSchema = z.looseObject({
  action: BrowserAction.optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  value: z.unknown().optional(),
  screenshot: z.unknown().optional(),
  tabs: z.array(UnknownRecord).optional(),
  downloads: z.array(UnknownRecord).optional(),
  error: z.string().optional(),
});
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

export const BrowserPreludeDetailsSchema = z.looseObject({
  kind: z.literal("browser").optional(),
  action: BrowserAction.optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  browser: z.string().optional(),
  viewport: UnknownRecord.optional(),
  observations: z.array(BrowserObservationSchema).optional(),
  value: z.unknown().optional(),
  screenshots: z.array(UnknownRecord).optional(),
  downloads: z.array(UnknownRecord).optional(),
  error: z.string().optional(),
  meta: OutputMetaSchema.optional(),
});
export type BrowserPreludeDetails = z.infer<typeof BrowserPreludeDetailsSchema>;

export const GhOperation = z.enum([
  "repo_view",
  "file_read",
  "pr_create",
  "pr_checkout",
  "pr_push",
  "search_issues",
  "search_prs",
  "search_code",
  "search_commits",
  "search_repos",
  "run_watch",
]);
export type GhOperation = z.infer<typeof GhOperation>;

export const GhToolArgsSchema = z.looseObject({
  op: GhOperation,
  repo: z.string().optional(),
  branch: z.string().optional(),
  path: z.string().optional(),
  pr: z.number().int().positive().optional(),
  force: z.boolean().optional(),
  forceWithLease: z.boolean().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  draft: z.boolean().optional(),
  fill: z.boolean().optional(),
  reviewer: z.string().optional(),
  assignee: z.string().optional(),
  label: z.string().optional(),
  query: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  dateField: z.string().optional(),
  limit: z.number().int().positive().optional(),
  run: z.string().optional(),
  tail: z.number().int().nonnegative().optional(),
});
export type GhToolArgs = z.infer<typeof GhToolArgsSchema>;

export const GhToolDetailsSchema = z.looseObject({
  kind: z.literal("github").optional(),
  op: GhOperation.optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  pullRequest: UnknownRecord.optional(),
  issue: UnknownRecord.optional(),
  diff: UnknownRecord.optional(),
  file: UnknownRecord.optional(),
  sourceLinks: z.array(z.string()).optional(),
  artifact: UnknownRecord.optional(),
  worktree: UnknownRecord.optional(),
  remote: UnknownRecord.optional(),
  headSha: z.string().optional(),
  run: UnknownRecord.optional(),
  jobs: z.array(UnknownRecord).optional(),
  failedLogTail: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  error: z.string().optional(),
  meta: OutputMetaSchema.optional(),
});
export type GhToolDetails = z.infer<typeof GhToolDetailsSchema>;

export const SearchSourceSchema = z.looseObject({
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  publishedDate: z.string().optional(),
  ageSeconds: z.number().nonnegative().optional(),
  author: z.string().optional(),
  domain: z.string().optional(),
});
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchCitationSchema = z.looseObject({
  url: z.string().optional(),
  title: z.string().optional(),
  citedText: z.string().optional(),
});
export type SearchCitation = z.infer<typeof SearchCitationSchema>;

export const SearchUsageSchema = z.looseObject({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  searchRequests: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});
export type SearchUsage = z.infer<typeof SearchUsageSchema>;

export const SearchResponseSchema = z.looseObject({
  provider: z.string().optional(),
  answer: z.string().optional(),
  sources: z.array(SearchSourceSchema),
  citations: z.array(SearchCitationSchema).optional(),
  searchQueries: z.array(z.string()).optional(),
  relatedQuestions: z.array(z.string()).optional(),
  usage: SearchUsageSchema.optional(),
  model: z.string().optional(),
  requestId: z.string().optional(),
  authMode: z.string().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SearchRenderDetailsSchema = z.looseObject({
  kind: z.literal("web_search").optional(),
  query: z.string().optional(),
  response: SearchResponseSchema,
  error: z.string().optional(),
});
export type SearchRenderDetails = z.infer<typeof SearchRenderDetailsSchema>;

/** Retrieval links only: prose cannot manufacture a source link. */
export function safeRetrievalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function mapT4Failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: fallback, retryable: false },
    { cause: error },
  );
}
