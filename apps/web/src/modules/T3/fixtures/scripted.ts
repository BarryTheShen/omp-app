/**
 * Scripted from omp v18.9.1's EvalTool result construction because the existing real recordings
 * contain no eval image. EvalTool puts an ImageContent in `result.content`, with raw base64 bytes
 * and a `mimeType`; its final `details` carries the cell snapshot but not the image bytes.
 */
export const T3_SCRIPTED_EVAL_IMAGE_RESULT = {
  toolName: "eval",
  args: {
    language: "py",
    code: "display(plot)",
    title: "Render a plot",
  },
  result: {
    content: [
      { type: "text", text: "(displayed 1 image; no text output)" },
      {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    ],
    details: {
      language: "python",
      languages: ["python"],
      cells: [
        {
          index: 0,
          title: "Render a plot",
          code: "display(plot)",
          language: "python",
          output: "",
          status: "complete",
          durationMs: 1,
          exitCode: 0,
        },
      ],
    },
  },
  isError: false,
} as const;
/**
 * Scripted from omp v18.9.1's `DapSessionSummary` and `formatSessions` because no real recording
 * contains a `debug(action: "sessions")` result. These are the exact session fields and row text
 * emitted by `packages/coding-agent/src/tools/debug.ts:410-424`.
 */
export const T3_SCRIPTED_DEBUG_SESSIONS_RESULT = {
  content: [
    {
      type: "text",
      text:
        "debug-session-1: stopped\n" +
        "  adapter=js-debug-adapter\n" +
        "  cwd=<WORKSPACE>\n" +
        "  program=<WORKSPACE>/apps/web/server.ts\n\n" +
        "debug-session-2: running\n" +
        "  adapter=debugpy\n" +
        "  cwd=<WORKSPACE>/scripts\n" +
        "  program=<WORKSPACE>/scripts/worker.py",
    },
  ],
  details: {
    action: "sessions",
    success: true,
    sessions: [
      {
        id: "debug-session-1",
        adapter: "js-debug-adapter",
        cwd: "<WORKSPACE>",
        program: "<WORKSPACE>/apps/web/server.ts",
        status: "stopped",
        launchedAt: "2026-10-18T12:00:00.000Z",
        lastUsedAt: "2026-10-18T12:00:04.000Z",
        breakpointFiles: 1,
        breakpointCount: 2,
        functionBreakpointCount: 0,
        outputBytes: 120,
        outputTruncated: false,
        needsConfigurationDone: false,
      },
      {
        id: "debug-session-2",
        adapter: "debugpy",
        cwd: "<WORKSPACE>/scripts",
        program: "<WORKSPACE>/scripts/worker.py",
        status: "running",
        launchedAt: "2026-10-18T12:01:00.000Z",
        lastUsedAt: "2026-10-18T12:01:04.000Z",
        breakpointFiles: 0,
        breakpointCount: 0,
        functionBreakpointCount: 0,
        outputBytes: 0,
        outputTruncated: false,
        needsConfigurationDone: false,
      },
    ],
  },
} as const;
