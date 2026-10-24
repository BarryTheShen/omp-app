import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * Scripted from omp's jfind output shape because the session store has no result with more than twenty hits.
 * Every hit is present in both the text and details so the renderer's 20-row presentation limit is testable.
 */
const HITS = [
  "<WORKSPACE>/src/alpha/one.ts",
  "<WORKSPACE>/src/alpha/two.ts",
  "<WORKSPACE>/src/alpha/three.ts",
  "<WORKSPACE>/src/beta/one.ts",
  "<WORKSPACE>/src/beta/two.ts",
  "<WORKSPACE>/src/beta/three.ts",
  "<WORKSPACE>/src/gamma/one.ts",
  "<WORKSPACE>/src/gamma/two.ts",
  "<WORKSPACE>/src/gamma/three.ts",
  "<WORKSPACE>/src/delta/one.ts",
  "<WORKSPACE>/src/delta/two.ts",
  "<WORKSPACE>/src/delta/three.ts",
  "<WORKSPACE>/src/epsilon/one.ts",
  "<WORKSPACE>/src/epsilon/two.ts",
  "<WORKSPACE>/src/epsilon/three.ts",
  "<WORKSPACE>/src/zeta/one.ts",
  "<WORKSPACE>/src/zeta/two.ts",
  "<WORKSPACE>/src/zeta/three.ts",
  "<WORKSPACE>/src/eta/one.ts",
  "<WORKSPACE>/src/eta/two.ts",
  "<WORKSPACE>/src/eta/three.ts",
] as const;

const QUERY = "where the application handles streamed tool results";
const KEYWORDS = ["application", "handles", "streamed", "tool", "results"];
const HITS_TEXT = HITS.map(
  (path, index) => `${path}  0.${String(92 - index).padStart(2, "0")}  100 lines judged`,
).join("\n");

export const T2_SCRIPTED_LARGE_FIND_RESULTS: readonly RealToolResult[] = [
  {
    name: "find: twenty-one scored hits, showing the first twenty",
    toolName: "find",
    args: { query: QUERY, grep_keywords: KEYWORDS, path: "<WORKSPACE>/src" },
    result: {
      content: [
        {
          type: "text",
          text: `21 hit(s) for "${QUERY}" in <WORKSPACE>/src (τ 0.20), strongest first\n\n${HITS_TEXT}`,
        },
      ],
      details: {
        query: QUERY,
        keywords: KEYWORDS,
        threshold: 0.2,
        hits: HITS.map((rel, index) => ({
          rel,
          nameScore: 0.9,
          contentScore: (92 - index) / 100,
          ranges: [{ start: 1, end: 100, p: (92 - index) / 100, snippet: "tool result" }],
          linesSeen: 100,
          truncated: false,
        })),
        coverage: "complete",
        stats: {
          listed: 21,
          requests: 21,
          failed: 0,
          unanswered: 0,
          judged: 21,
          filesRead: 21,
          fileBytes: 210000,
          inputTokens: 2100,
          outputTokens: 210,
          cost: 0,
          apiMs: 210,
          windowsJudged: 21,
          windowsPruned: 0,
          mapCards: 21,
          failures: [],
        },
        elapsedMs: 210,
        cwd: "<WORKSPACE>",
        scopePath: "<WORKSPACE>/src",
      },
    },
    isError: false,
    shows: ["21 hits", "Showing 20 of 21", "one.ts", "three.ts"],
  },
];
