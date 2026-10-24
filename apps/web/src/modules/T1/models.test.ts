import { AppFailure, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T1_TOOL_DESCRIPTORS } from "./descriptor";
import {
  decodeAstEditArgs,
  decodeAstEditDetails,
  decodeEditArgs,
  decodeEditDetails,
  decodeReadArgs,
  decodeReadDetails,
  decodeWriteArgs,
  decodeWriteDetails,
  type ReadToolDetails,
} from "./models";
import { dispatchReadUrl } from "./read-url-seam";

describe("T1 file operation models", () => {
  test("decodes read args and preserves future detail fields", () => {
    const args = decodeReadArgs({ path: "src/index.ts", offset: 4, limit: 12 });
    expect(args.ok).toBe(true);
    expect(args.ok && args.value.path).toBe("src/index.ts");
    const details = decodeReadDetails({
      kind: "file",
      displayTarget: "src/index.ts",
      displayContent: { text: "const answer = 42;", startLine: 4 },
      futureDetail: { value: "raw" },
    });
    expect(details.ok).toBe(true);
    expect(details.ok && details.value.futureDetail).toEqual({ value: "raw" });
  });

  test("decodes write/edit/ast_edit args and detail metadata", () => {
    expect(decodeWriteArgs({ path: "a.ts", content: "export {};" }).ok).toBe(true);
    expect(
      decodeWriteDetails({
        madeExecutable: true,
        diagnostics: {
          server: "typescript",
          messages: ["a.ts:1:1 [warning] unused"],
          summary: "1 warning(s)",
          errored: false,
        },
      }).ok,
    ).toBe(true);
    expect(decodeEditArgs({ path: "a.ts", oldText: "a", newText: "b" }).ok).toBe(true);
    expect(decodeEditDetails({ op: "update", diff: "-a\n+b" }).ok).toBe(true);
    expect(decodeAstEditArgs({ ops: [{ pat: "old", out: "new" }], paths: ["src"] }).ok).toBe(true);
    expect(decodeAstEditDetails({ applied: true, filesTouched: 1, limitReached: false }).ok).toBe(
      true,
    );
  });

  test("turns malformed args/details into typed invalid_args fallback states", () => {
    const malformed = [
      decodeReadArgs({}),
      decodeWriteArgs({ path: "a.ts" }),
      decodeEditDetails({ op: "unknown" }),
      decodeAstEditArgs({ ops: [], paths: "src" }),
    ];
    for (const result of malformed) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AppFailure);
        expect(result.error.appError.code).toBe("invalid_args");
      }
    }
  });

  test("claims exactly the five T1 rows and the shared T4 read URL row", () => {
    expect(validateRegistry(T1_TOOL_DESCRIPTORS)).toEqual([]);
    expect(T1_TOOL_DESCRIPTORS).toHaveLength(5);
    expect(T1_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T1.read")?.covers).toEqual([
      "T1.read",
      "T4.fetch-read-url-path",
    ]);
  });
});

describe("T1 read URL seam", () => {
  test("dispatches URL details only to the injected renderer", () => {
    const details: ReadToolDetails = { kind: "url", url: "skill://review" };
    const renderer = (props: { readonly details: ReadToolDetails }) => `url:${props.details.url}`;
    const dispatched = dispatchReadUrl(
      {
        toolCallId: "read-1" as never,
        rendererProps: {} as never,
        details,
        rawArgs: '{"path":"skill://review"}',
        rawResult: "content",
        text: "content",
      },
      renderer,
    );
    expect(dispatched).toBe("url:skill://review");
    expect(
      dispatchReadUrl(
        {
          toolCallId: "read-2" as never,
          rendererProps: {} as never,
          details: { kind: "file", displayTarget: "a.ts" },
          rawArgs: "{}",
          rawResult: "file",
          text: "file",
        },
        renderer,
      ),
    ).toBeNull();
  });

  test("keeps a URL visible as metadata when T4 has not registered a renderer", () => {
    expect(
      dispatchReadUrl(
        {
          toolCallId: "read-3" as never,
          rendererProps: {} as never,
          details: { kind: "url", url: "rule://security" },
          rawArgs: "{}",
          rawResult: "rule",
          text: "rule",
        },
        undefined,
      ),
    ).toBeNull();
  });
});
