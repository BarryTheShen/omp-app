import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T2_DESCRIPTORS } from "./descriptor";
import {
  decodeAstGrepArgs,
  decodeAstGrepDetails,
  decodeFindArgs,
  decodeFindDetails,
  decodeGlobArgs,
  decodeGlobDetails,
  decodeGrepArgs,
  decodeGrepDetails,
  decodeLateDiagnostic,
  decodeLspArgs,
  decodeLspDetails,
} from "./models";

describe("T2 search and code-intelligence models", () => {
  test("decodes grep and glob shapes while retaining future fields", () => {
    const grepArgs = decodeGrepArgs({ pattern: "TODO", path: "src", case: false, futureArg: true });
    expect(grepArgs.ok).toBe(true);
    expect(grepArgs.ok && grepArgs.value.pattern).toBe("TODO");
    expect(grepArgs.ok && grepArgs.value.futureArg).toBe(true);

    const grepDetails = decodeGrepDetails({
      fileCount: 1,
      fileMatches: [{ path: "src/a.ts", count: 1, futureMatch: "kept" }],
      missingPaths: ["missing"],
    });
    expect(grepDetails.ok).toBe(true);
    expect(grepDetails.ok && grepDetails.value.fileMatches?.[0]?.futureMatch).toBe("kept");

    expect(decodeGlobArgs({ path: "src", hidden: true, limit: 20 }).ok).toBe(true);
    expect(decodeGlobDetails({ files: ["src/a.ts"], resultLimitReached: 5 }).ok).toBe(true);
    expect(
      decodeGrepDetails({
        matchCount: 2,
        files: ["src/a.ts"],
        fileLimitReached: 5,
        displayTargets: { "omp://x": "/repo/x" },
      }).ok,
    ).toBe(true);
  });

  test("decodes semantic find exactly as query plus lexical keywords", () => {
    const args = decodeFindArgs({
      query: "find the auth boundary",
      grep_keywords: ["auth", "boundary"],
      path: "src",
    });
    expect(args.ok).toBe(true);
    expect(args.ok && args.value.query).toContain("auth boundary");
    expect(
      decodeFindDetails({
        threshold: 0.42,
        hits: [{ rel: "src/auth.ts", contentScore: 0.91, ranges: [{ start: 4, end: 8 }] }],
        stats: { judged: 1, filesRead: 2 },
        futureStats: { preserved: true },
      }).ok,
    ).toBe(true);
  });

  test("decodes omp v18.6.1's real find details, including string failures and range scores", () => {
    // Shape from omp v18.6.1 packages/tui/test/find-render.test.ts:15-56.
    const details = decodeFindDetails({
      query: "retry budget",
      keywords: ["retry", "budget"],
      threshold: 0.2,
      cwd: "/repo",
      elapsedMs: 1500,
      hits: [
        {
          rel: "src/retry.ts",
          nameScore: 0.8,
          contentScore: 0.9,
          linesSeen: 120,
          truncated: false,
          ranges: [{ start: 10, end: 20, p: 0.9, snippet: "function retryBudget() {" }],
        },
      ],
      stats: {
        listed: 2,
        requests: 3,
        errors: 1,
        judged: 2,
        filesRead: 2,
        fileBytes: 100,
        inputTokens: 1200,
        outputTokens: 0,
        cost: 0,
        apiMs: 900,
        windowsJudged: 4,
        windowsPruned: 1,
        mapCards: 3,
        failures: ["verification: boom"],
      },
    });
    expect(details.ok).toBe(true);
    expect(details.ok && details.value.hits?.[0]?.ranges?.[0]?.p).toBe(0.9);
    expect(details.ok && details.value.stats?.failures).toEqual(["verification: boom"]);
    expect(details.ok && details.value.stats?.inputTokens).toBe(1200);
  });

  test("decodes omp v18.6.1's real ast_grep and lsp shapes without executing code", () => {
    // ast_grep params: omp packages/coding-agent/src/tools/ast-grep.ts:33-40.
    expect(decodeAstGrepArgs({ pat: "console.log($$$)", path: "src", lang: "ts" }).ok).toBe(true);
    expect(decodeAstGrepArgs({ pattern: "$A" }).ok).toBe(false);
    // ast_grep details: omp packages/coding-agent/src/tools/ast-grep.ts:260-352.
    const astDetails = decodeAstGrepDetails({
      matchCount: 2,
      fileCount: 1,
      filesSearched: 14,
      limitReached: false,
      parseErrors: ["src/bad.ts: parse error (syntax tree contains error nodes)"],
      parseErrorsTotal: 1,
      scopePath: "src",
      searchPath: "/repo/src",
      cwd: "/repo",
      files: ["src/a.ts"],
      fileMatches: [{ path: "src/a.ts", count: 2 }],
      displayContent: "# src/a.ts\n *4│console.log(a)\n *9│console.log(b)",
    });
    expect(astDetails.ok && astDetails.value.fileMatches?.[0]?.count).toBe(2);
    expect(decodeAstGrepDetails({ files: [{ path: "src/a.ts" }] }).ok).toBe(false);
    expect(
      decodeLspArgs({
        action: "rename",
        file: "src/a.ts",
        line: 4,
        symbol: "value",
        new_name: "next",
        timeout: 7.5,
      }).ok,
    ).toBe(true);
    // lsp details: omp packages/tui/src/tools/lsp.ts:67-72; the answer itself is text content.
    const lspDetails = decodeLspDetails({
      serverName: "typescript-language-server",
      action: "hover",
      success: true,
      request: { action: "hover", file: "src/a.ts", line: 4 },
    });
    expect(lspDetails.ok && lspDetails.value.success).toBe(true);
  });

  test("adapts late diagnostics to the existing tool call without inventing an id", () => {
    const attached = decodeLateDiagnostic({
      customType: "lsp-late-diagnostic",
      relatedToolCallId: "call-lsp-1",
      details: { files: [{ path: "src/a.ts", diagnostics: [{ severity: 1, message: "bad" }] }] },
    });
    expect(attached.ok).toBe(true);
    expect(attached.ok && attached.value.attachmentToolCallId).toBe("call-lsp-1");

    const unattached = decodeLateDiagnostic({
      customType: "lsp-late-diagnostic",
      details: { files: [] },
    });
    expect(unattached.ok).toBe(true);
    expect(unattached.ok && unattached.value.attachmentToolCallId).toBeUndefined();
  });

  test("malformed details become typed invalid_args results", () => {
    const result = decodeFindArgs({ grep_keywords: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.appError.code).toBe("invalid_args");
  });
});

describe("T2 descriptors", () => {
  test("claims the five tools and one late-message row exactly once", () => {
    expect(validateRegistry(T2_DESCRIPTORS)).toEqual([]);
    expect(T2_DESCRIPTORS).toHaveLength(6);
    expect(T2_DESCRIPTORS.map((descriptor) => descriptor.covers[0])).toEqual([
      "T2.ast-grep",
      "T2.find-legacy-alias-to-glob",
      "T2.glob",
      "T2.grep",
      "T2.lsp",
      "T2.late-lsp-diagnostics",
    ]);
    expect(T2_DESCRIPTORS.find((descriptor) => descriptor.id === "T2.semanticFind")?.title).toBe(
      "Semantic search",
    );
  });
});
