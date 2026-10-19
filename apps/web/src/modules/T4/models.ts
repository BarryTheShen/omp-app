import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import { ReadToolDetailsSchema } from "../T1/models";
import { OutputMetaSchema } from "../U3/tool-card/output-meta";

const UnknownRecord = z.record(z.string(), z.unknown());

/** T1's normalized URL read details, narrowed without duplicating its read model. */
export const ReadUrlToolDetailsSchema = ReadToolDetailsSchema.extend({ kind: z.literal("url") });
export type ReadUrlToolDetails = z.infer<typeof ReadUrlToolDetailsSchema>;

export const BrowserAction = z.enum(["open", "close", "run", "call", "tabs", "targets"]);
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

export const BrowserScreenshotSchema = z.looseObject({
  dest: z.string(),
  mimeType: z.string(),
  bytes: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type BrowserScreenshot = z.infer<typeof BrowserScreenshotSchema>;

/** omp v18.9.1 BrowserPreludeDetails from packages/coding-agent/src/tools/browser.ts:147-156. */
export const BrowserPreludeDetailsSchema = z.looseObject({
  meta: OutputMetaSchema.optional(),
  action: BrowserAction,
  name: z.string(),
  url: z.string().optional(),
  browser: z.string().optional(),
  viewport: UnknownRecord.optional(),
  screenshots: z.array(BrowserScreenshotSchema).optional(),
  value: z.unknown().optional(),
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

/** omp v18.9.1 GhToolDetails from packages/tui/src/tools/github.ts:601-617. */
export const GhPrCheckoutSummarySchema = z.looseObject({
  prNumber: z.number().int().positive().optional(),
  url: z.string().optional(),
  branch: z.string(),
  worktreePath: z.string(),
  remote: z.string(),
  remoteBranch: z.string(),
  reused: z.boolean(),
  clonedWith: z.string().optional(),
});

export const GhRunWatchDetailsSchema = z.looseObject({
  mode: z.enum(["run", "commit"]),
  state: z.enum(["watching", "completed"]),
  repo: z.string(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  pollCount: z.number().nonnegative().optional(),
  note: z.string().optional(),
  run: UnknownRecord.optional(),
  runs: z.array(UnknownRecord).optional(),
  failedLogs: z.array(UnknownRecord).optional(),
});

export const GhToolDetailsSchema = z.looseObject({
  meta: OutputMetaSchema.optional(),
  artifactId: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  remote: z.string().optional(),
  remoteBranch: z.string().optional(),
  headSha: z.string().optional(),
  runId: z.number().optional(),
  runIds: z.array(z.number()).optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  failedJobs: z.array(z.string()).optional(),
  watch: GhRunWatchDetailsSchema.optional(),
  checkouts: z.array(GhPrCheckoutSummarySchema).optional(),
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
  totalTokens: z.number().nonnegative().optional(),
  searchRequests: z.number().nonnegative().optional(),
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

/** omp v18.9.1 packages/tui/src/tools/web-search-types.ts:12-46. */
const SEARCH_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  brave: "Brave",
  codex: "OpenAI Codex",
  duckduckgo: "DuckDuckGo",
  ecosia: "Ecosia",
  exa: "Exa",
  firecrawl: "Firecrawl",
  gemini: "Gemini",
  google: "Google",
  jina: "Jina",
  kagi: "Kagi",
  kimi: "Kimi",
  mojeek: "Mojeek",
  ollama: "Ollama",
  openai: "OpenAI API",
  openrouter: "OpenRouter",
  parallel: "Parallel",
  perplexity: "Perplexity",
  public: "Public Web",
  searxng: "SearXNG",
  startpage: "Startpage",
  synthetic: "Synthetic",
  tavily: "Tavily",
  tinyfish: "TinyFish",
  xai: "xAI",
  zai: "Z.AI",
};

export function searchProviderLabel(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  if (provider === "none") return "None";
  return SEARCH_PROVIDER_LABELS[provider] ?? "Web search";
}

/** omp v18.9.1 packages/tui/src/tools/web-search.ts:140-143. */
export function searchAuthLabel(authMode: string | undefined): string | undefined {
  if (authMode === undefined) return undefined;
  if (authMode === "oauth") return "OAuth";
  if (authMode === "api_key") return "API";
  if (authMode === "anonymous") return "Anonymous";
  return "Authentication";
}

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
