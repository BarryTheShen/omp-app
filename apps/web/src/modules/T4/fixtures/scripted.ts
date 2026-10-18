import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * Scripted from omp v18.9.1 builders: web-search formatting uses formatForLLM (web/search/index.ts:60-110),
 * browser display/value uses runInTab and BrowserPreludeDetails (tools/browser.ts:147-156,645-671),
 * repo/file text uses formatRepoView and executeFileRead (tools/gh-view.ts:312-336; tools/gh.ts:193-291).
 */
const SEARCH_SOURCES = Array.from({ length: 33 }, (_, index) => ({
  title: `Reference ${index + 1}`,
  url: `https://example.test/reference-${index + 1}`,
  snippet: `Reference ${index + 1} describes the requested subject.`,
  publishedDate: "2026-10-01",
}));
const SEARCH_ANSWER = "These references summarize the requested subject.";
const SOURCE_TEXT = [
  SEARCH_ANSWER,
  "\n## Sources",
  "33 sources",
  ...SEARCH_SOURCES.map(
    (source, index) =>
      `[${index + 1}] ${source.title} (${source.publishedDate})\n    ${source.url}\n    ${source.snippet}`,
  ),
].join("\n");
const BROWSER_LINES = Array.from({ length: 24 }, (_, index) => `Displayed line ${index + 1}`);
const GITHUB_FILE_LINES = Array.from(
  { length: 180 },
  (_, index) => `README fixture line ${index + 1}`,
);
const LARGE_ANSWER = `Answer begins. ${"The requested answer remains within the source text. ".repeat(900)} Answer ends after the inline limit.`;
const RELATED_QUESTIONS = Array.from({ length: 9 }, (_, index) => `Related question ${index + 1}?`);
const CITATIONS = Array.from({ length: 33 }, (_, index) => ({
  title: `Citation ${index + 1}`,
  url: `https://example.test/citation-${index + 1}`,
  citedText: `Cited passage ${index + 1}.`,
}));
const RELATED_TEXT = [
  "Answer with related questions.",
  "\n## Related",
  "9 questions",
  ...RELATED_QUESTIONS.map((question) => `- ${question}`),
].join("\n");
const CITATION_TEXT = [
  "\n## Citations",
  "33 citations",
  ...CITATIONS.map(
    (citation, index) =>
      `[${index + 1}] ${citation.title}\n    ${citation.url}\n    ${citation.citedText}`,
  ),
].join("\n");

export const T4_SCRIPTED_RESULTS: readonly RealToolResult[] = [
  {
    name: "browser: scripted long console display folded by shared text output",
    toolName: "browser",
    args: {
      action: "run",
      name: "main",
      code: 'for (let i=1;i<=24;i++) console.log("Displayed line "+i); return "done";',
    },
    result: {
      content: [{ type: "text", text: BROWSER_LINES.join("\n") }],
      details: { action: "run", name: "main", value: "done" },
    },
    isError: false,
    shows: ["Show all 24 lines", "Displayed line 1"],
  },
  {
    name: "web_search: scripted 33-source result, showing the first 32",
    toolName: "web_search",
    args: { query: "requested subject with many sources" },
    result: {
      content: [{ type: "text", text: SOURCE_TEXT }],
      details: { response: { provider: "exa", answer: SEARCH_ANSWER, sources: SEARCH_SOURCES } },
    },
    isError: false,
    shows: ["Showing 32 of 33 sources.", "Reference 1", "Reference 32"],
  },
  {
    name: "web_search: scripted answer with no sources",
    toolName: "web_search",
    args: { query: "a query with no sources" },
    result: {
      content: [{ type: "text", text: "The search returned an answer without sources." }],
      details: {
        response: {
          provider: "exa",
          answer: "The search returned an answer without sources.",
          sources: [],
        },
      },
    },
    isError: false,
    shows: ["No sources were returned for this search."],
  },
  {
    name: "web_search: scripted provider-unavailable result",
    toolName: "web_search",
    args: { query: "a query with no configured search model" },
    result: {
      content: [{ type: "text", text: "Error: No web search model configured." }],
      details: {
        response: { provider: "none", sources: [] },
        error: "No web search model configured.",
      },
    },
    isError: false,
    shows: ["No web search model configured."],
  },
  {
    name: "web_search: scripted long answer beyond the inline limit",
    toolName: "web_search",
    args: { query: "a long answer with no sources" },
    result: {
      content: [{ type: "text", text: LARGE_ANSWER }],
      details: { response: { provider: "exa", answer: LARGE_ANSWER, sources: [] } },
    },
    isError: false,
    shows: ["Answer begins."],
  },
  {
    name: "web_search: scripted related-question limit",
    toolName: "web_search",
    args: { query: "related question limit" },
    result: {
      content: [{ type: "text", text: RELATED_TEXT }],
      details: {
        response: {
          provider: "exa",
          answer: "Answer with related questions.",
          sources: [],
          relatedQuestions: RELATED_QUESTIONS,
        },
      },
    },
    isError: false,
    shows: ["Showing 8 of 9 questions."],
  },
  {
    name: "web_search: scripted citation limit",
    toolName: "web_search",
    args: { query: "citation limit" },
    result: {
      content: [{ type: "text", text: CITATION_TEXT }],
      details: { response: { provider: "exa", sources: [], citations: CITATIONS } },
    },
    isError: false,
    shows: ["Showing 32 of 33 citations."],
  },
  {
    name: "github: scripted repository view in omp's builder format",
    toolName: "github",
    args: { op: "repo_view", repo: "octo/example" },
    result: {
      content: [
        {
          type: "text",
          text: "# octo/example\n\nExample repository fixture.\n\nURL: https://github.com/octo/example\nDefault branch: main\nPrimary language: TypeScript\nStars: 42",
        },
      ],
      details: { meta: { source: { type: "url", value: "https://github.com/octo/example" } } },
    },
    isError: false,
    shows: ["octo/example", "Repository", "Complete"],
  },
  {
    name: "github: scripted long text-file result through the contents API",
    toolName: "github",
    args: { op: "file_read", repo: "octo/example", branch: "main", path: "README.md" },
    result: {
      content: [{ type: "text", text: GITHUB_FILE_LINES.join("\n") }],
      details: {
        repo: "octo/example",
        branch: "main",
        meta: {
          source: { type: "url", value: "https://github.com/octo/example/blob/main/README.md" },
        },
      },
    },
    isError: false,
    shows: ["octo/example", "File", "main"],
  },
];

export const T4_SCRIPTED_LIMITS = {
  largeAnswer: LARGE_ANSWER,
  maxAnswerCharacters: 40_000,
} as const;
