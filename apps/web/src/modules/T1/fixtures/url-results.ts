import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * A read of a web page that omp cut at its limit. the owner's session store holds URL reads (`details.kind` is "url"); the keys
 * and nesting here are the recorded ones, and the URL, text and numbers are replaced. The text starts with the header
 * block omp writes (packages/coding-agent/src/tools/fetch.ts:1705-1715: `URL:`, `Content-Type:`, `Method:`, an optional
 * `Notes:` line, then `---`). Omp writes no note about the cut: the truncation lives in `meta.truncation`, so `notes` is
 * empty. It is kept out of real-results.ts: T4's renderer draws URL reads in the running app, so this sample feeds only
 * the lifecycle fixtures, through a stub renderer.
 */
export const T1_URL_RESULTS: readonly RealToolResult[] = [
  {
    name: "read: a web page, cut by omp at its limit",
    toolName: "read",
    args: { path: "https://example.com/docs/guide" },
    result: {
      content: [
        {
          type: "text",
          text: "URL: https://example.com/docs/guide\nContent-Type: text/markdown\nMethod: GET\n\n---\n\n# Guide\n\nThe first lines of the page; the rest is in the next read.",
        },
      ],
      details: {
        kind: "url",
        url: "https://example.com/docs/guide",
        finalUrl: "https://example.com/docs/guide",
        contentType: "text/markdown",
        method: "GET",
        truncated: true,
        notes: [],
        meta: {
          source: { type: "url", value: "https://example.com/docs/guide" },
          truncation: {
            direction: "head",
            truncatedBy: "lines",
            totalLines: 120,
            totalBytes: 4310,
            outputLines: 3,
            outputBytes: 96,
            shownRange: { start: 1, end: 3 },
            artifactId: "url-guide-1",
            nextOffset: 4,
          },
        },
      },
    },
    isError: false,
    shows: ["URL: https://example.com/docs/guide"],
  },
];
