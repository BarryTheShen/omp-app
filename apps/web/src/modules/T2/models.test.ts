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
    expect(decodeGlobDetails({ files: [{ path: "src/a.ts", target: "src/a.ts" }] }).ok).toBe(true);
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

  test("decodes ast_grep and every LSP action without executing code", () => {
    expect(decodeAstGrepArgs({ pattern: "$A", path: "src", language: "typescript" }).ok).toBe(true);
    expect(
      decodeAstGrepDetails({ matches: [{ path: "src/a.ts", line: 4 }], parseErrors: [] }).ok,
    ).toBe(true);
    expect(
      decodeLspArgs({
        action: "rename",
        file: "src/a.ts",
        line: 4,
        symbol: "value",
        new_name: "next",
      }).ok,
    ).toBe(true);
    expect(
      decodeLspDetails({
        serverName: "typescript",
        action: "diagnostics",
        diagnostics: [{ path: "src/a.ts", messages: [{ severity: "error", message: "bad" }] }],
        formatter: "formatted",
      }).ok,
    ).toBe(true);
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
