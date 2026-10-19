/**
 * Result envelopes follow omp v18.9.1 builders. Browser fields come from
 * packages/coding-agent/src/tools/browser.ts:147-156,652-670; GitHub details from
 * packages/tui/src/tools/github.ts:601-617 and the search response from
 * packages/tui/src/tools/web-search-types.ts:12-76.
 */
export const BROWSER_RESULT = {
  content: [{ type: "text", text: "Get started with Bun" }],
  details: {
    action: "run",
    name: "docs",
    url: "https://bun.sh/docs",
    browser: "headless",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    value: "Get started with Bun",
    screenshots: [
      {
        dest: "<TMP>/browser-screenshot.png",
        mimeType: "image/png",
        bytes: 2048,
        width: 1280,
        height: 800,
      },
    ],
  },
} as const;

export const BROWSER_ERROR_RESULT = {
  content: [{ type: "text", text: "Browser permission denied" }],
  details: { action: "open", name: "docs", url: "https://bun.sh/docs" },
} as const;

export const GITHUB_PUSH_RESULT = {
  content: [
    {
      type: "text",
      text: [
        "# Pushed Pull Request Branch",
        "",
        "Local branch: feature/t4-results",
        "Remote: origin",
        "Remote branch: feature/t4-results",
        "Remote URL: https://github.com/example/repository.git",
        "PR: https://github.com/example/repository/pull/42",
        "Force with lease: false",
        "",
        "Pushed feature/t4-results to origin:feature/t4-results.",
      ].join("\n"),
    },
  ],
  details: {
    branch: "feature/t4-results",
    remote: "origin",
    remoteBranch: "feature/t4-results",
    meta: { source: { type: "url", value: "https://github.com/example/repository/pull/42" } },
  },
} as const;

export const SEARCH_RESULT = {
  content: [{ type: "text", text: "Bun is fast for script-heavy workflows." }],
  details: {
    response: {
      provider: "perplexity",
      model: "sonar-pro",
      authMode: "api_key",
      answer: "Bun is fast for script-heavy workflows.",
      sources: [
        {
          title: "Bun 1.2 Benchmarks",
          url: "https://bun.sh/blog/bun-v1.2-benchmarks",
          snippet: "Bun serves roughly 2.5x the requests per second of Node.js.",
          ageSeconds: 86_400,
          author: "The Bun Team",
        },
        { title: "", url: "https://www.example.test/docs/syllabus.pdf" },
      ],
      usage: { inputTokens: 312, outputTokens: 248, totalTokens: 560, searchRequests: 2 },
    },
  },
} as const;

export const GITHUB_WATCH_RESULT = {
  content: [{ type: "text", text: "Workflow run #4 is still running." }],
  details: {
    repo: "example/repository",
    status: "in_progress",
    runId: 4,
    watch: {
      mode: "run",
      state: "watching",
      repo: "example/repository",
      run: {
        id: 4,
        workflowName: "CI",
        status: "in_progress",
        jobs: [{ id: 7, name: "tests", status: "running" }],
      },
    },
  },
} as const;

/** [scripted] Five screenshot metadata rows follow v18.9.1 ScreenshotResult at browser.ts:147-156. */
export const BROWSER_MANY_SCREENSHOTS_RESULT = {
  content: [{ type: "text", text: "Get started with Bun" }],
  details: {
    action: "run",
    name: "docs",
    value: "Get started with Bun",
    screenshots: Array.from({ length: 5 }, (_, index) => ({
      dest: `<TMP>/browser-screenshot-${index + 1}.png`,
      mimeType: "image/png",
      bytes: 2048 + index,
      width: 1280,
      height: 800,
    })),
  },
} as const;

/** [scripted] GhToolDetails.status/conclusion follows omp github.ts:601-617. */
export const GITHUB_CANCELLED_RESULT = {
  content: [{ type: "text", text: "Workflow run #4 was cancelled." }],
  details: { repo: "example/repository", conclusion: "cancelled", runId: 4 },
} as const;

/** [scripted] Search operations return formatted text, not structured rows (gh-search.ts:506-521). */
export const GITHUB_SEARCH_RESULT = {
  content: [{ type: "text", text: "Issues matching `rules`:\\n\\n#42 Add rule panel\\n" }],
  details: {},
} as const;
