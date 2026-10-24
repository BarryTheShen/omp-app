import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";
import { EditCard } from "./edit";
import { ReadCard } from "./read";
import { WriteCard } from "./write";

afterEach(cleanup);

/**
 * Every `details` object below has the shape omp v18.12.6 builds, with the source line named next to it. Paths,
 * counts and file contents are invented; the keys, their types and the diagnostics format are omp's. The compiler
 * diagnostics lines are hand-written in the format of `packages/coding-agent/src/lsp/utils.ts`.
 */

function toolProps(
  toolName: string,
  args: unknown,
  details: unknown,
  text = "",
  toolCallId = `${toolName}-1`,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result: { content: [{ type: "text", text }], details },
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

const ERROR_LINE = "src/retry.ts:1:14 [error] Type 'number' is not assignable to type 'string'.";
/** `FileDiagnosticsResult` (`packages/tui/src/tools/lsp.ts:77-88`): the diagnostics an edit or a write carries. */
const FILE_DIAGNOSTICS = {
  server: "typescript",
  messages: [ERROR_LINE],
  summary: "1 error(s)",
  errored: true,
} as const;
/** `meta.diagnostics` as `OutputMetaBuilder.diagnostics` stores it (`packages/coding-agent/src/tools/output-meta.ts:425-430`). */
const META_DIAGNOSTICS = { summary: "1 error(s)", messages: [ERROR_LINE] } as const;

describe("edit details as omp v18.12.6 builds them", () => {
  // `packages/coding-agent/src/edit/index.ts:260-277` (one file): `move` is the destination path, `sourcePath` the
  // old one, and `meta` comes from `outputMeta().diagnostics(...)` (:254-256). `packages/tui/src/tools/edit.ts:97-122`.
  const MOVED = {
    diff: "@@ -1,1 +1,1 @@\n-1|export const retries = 2;\n+1|export const retries = 3;",
    firstChangedLine: 1,
    diagnostics: FILE_DIAGNOSTICS,
    op: "update",
    move: "src/retry.ts",
    sourcePath: "src/app.ts",
    path: "src/retry.ts",
    oldText: "export const retries = 2;\n",
    newText: "export const retries = 3;\n",
    meta: { diagnostics: META_DIAGNOSTICS },
  } as const;

  test("an edit that moved the file shows its diff, both paths and the diagnostics", () => {
    render(
      <EditCard
        rendererProps={toolProps("edit", { path: "src/app.ts", input: "…" }, MOVED, "Moved.")}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("Edit result unavailable")).toBeNull();
    const card = screen.getByTestId("t1-edit-card").textContent ?? "";
    expect(card).toContain("src/app.ts → src/retry.ts");
    expect(card).toContain("export const retries = 3;");
    expect(screen.getByText(ERROR_LINE)).toBeTruthy();
  });

  test("an edit with LSP diagnostics keeps its diff: meta.diagnostics is { summary, messages }, not a list", () => {
    const { move: _move, sourcePath: _sourcePath, ...inPlace } = MOVED;
    render(
      <EditCard
        rendererProps={toolProps(
          "edit",
          { path: "src/retry.ts", oldText: "2", newText: "3" },
          { ...inPlace, path: "src/retry.ts" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("Edit result unavailable")).toBeNull();
    expect(screen.getByTestId("t1-edit-card").textContent).toContain("export const retries = 3;");
    expect(screen.getByText(ERROR_LINE)).toBeTruthy();
  });

  test("a multi-file result shows each file's move: perFileResults[].move is a string", () => {
    // `toPerFileResult` (`packages/coding-agent/src/edit/index.ts:237-257`) and the multi-file aggregate (:279-286).
    const rows = [
      {
        path: "src/a.ts",
        diff: "@@ -1,1 +1,1 @@\n-1|a\n+1|b",
        op: "update",
        oldText: "a\n",
        newText: "b\n",
        meta: { diagnostics: META_DIAGNOSTICS },
      },
      {
        path: "src/c.ts",
        diff: "@@ -1,1 +1,1 @@\n-1|old\n+1|new",
        op: "update",
        move: "src/c.ts",
        sourcePath: "src/b.ts",
        oldText: "old\n",
        newText: "new\n",
        meta: { diagnostics: META_DIAGNOSTICS },
      },
    ];
    render(
      <EditCard
        rendererProps={toolProps(
          "apply_patch",
          { input: "*** Begin Patch\n*** Update File: src/a.ts" },
          {
            diff: rows.map((row) => row.diff).join("\n"),
            firstChangedLine: 1,
            perFileResults: rows,
          },
        )}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("Edit result unavailable")).toBeNull();
    expect(screen.getAllByTestId("t1-edit-file")).toHaveLength(2);
    expect(screen.getByText(/src\/b\.ts → src\/c\.ts/)).toBeTruthy();
  });
});

describe("write details as omp v18.12.6 builds them", () => {
  // `packages/coding-agent/src/tools/write.ts:1030-1041`: `diagnostics` is the `FileDiagnosticsResult` the LSP
  // write-through returned, and `meta.diagnostics` repeats its summary and messages. `packages/tui/src/tools/write.ts:74-87`.
  test("a write with LSP diagnostics shows them: details.diagnostics is { server, messages, summary, errored }", () => {
    render(
      <WriteCard
        rendererProps={toolProps(
          "write",
          { path: "src/retry.ts", content: "export const retries: string = 3;\n" },
          {
            resolvedPath: "/work/src/retry.ts",
            diagnostics: FILE_DIAGNOSTICS,
            meta: { diagnostics: META_DIAGNOSTICS },
          },
          "Successfully wrote 33 bytes to src/retry.ts",
        )}
      />,
    );
    expandToolCards();

    const body = screen.getByTestId("t1-write-card");
    expect(within(body).getByText(ERROR_LINE)).toBeTruthy();
    expect(within(body).getByText(/1 error\(s\)/)).toBeTruthy();
    expect(within(body).queryByText(/malformed/i)).toBeNull();
  });
});

describe("read details as omp v18.12.6 builds them", () => {
  test("a read resolved by suffix shows where it went: suffixResolution is { from, to }", () => {
    // `packages/coding-agent/src/tools/read.ts:1956-1991` (the match) and :2803-2806 (details and notice);
    // `packages/tui/src/tools/read.ts:65`.
    render(
      <ReadCard
        rendererProps={toolProps(
          "read",
          { path: "main.ts" },
          {
            resolvedPath: "/work/src/app/main.ts",
            displayContent: { text: "export const main = 1;", startLine: 1, lineNumbers: [1] },
            totalLines: 1,
            rowPrefixes: true,
            fileSize: 23,
            suffixResolution: { from: "main.ts", to: "src/app/main.ts" },
          },
          "[Path 'main.ts' not found; resolved to 'src/app/main.ts' via suffix match]\n1:export const main = 1;",
        )}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("Read result unavailable")).toBeNull();
    expect(screen.getByText("export const main = 1;")).toBeTruthy();
    expect(
      screen.getByText("Path 'main.ts' not found; resolved to 'src/app/main.ts' via suffix match"),
    ).toBeTruthy();
  });

  test("a delimited read with a failed part still shows its text: displayReadTargetLinks holds null for it", () => {
    // `packages/coding-agent/src/tools/read.ts:1214-1272`: a part that could not be read pushes `null` (:1264);
    // `packages/tui/src/tools/read.ts:96-101`.
    render(
      <ReadCard
        rendererProps={toolProps(
          "read",
          { path: "src/a.ts;src/missing.ts" },
          {
            notes: [
              "Note: interpreted as 2 paths: src/a.ts, src/missing.ts",
              "Could not read src/missing.ts: Path 'src/missing.ts' not found",
            ],
            displayReadTargets: ["src/a.ts", "src/missing.ts"],
            displayReadTargetLinks: ["/work/src/a.ts", null],
          },
          "Note: interpreted as 2 paths: src/a.ts, src/missing.ts\n\n1:const a = 1;\n\n[Could not read src/missing.ts: Path 'src/missing.ts' not found]",
        )}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("Read result unavailable")).toBeNull();
    expect(screen.getByTestId("t1-read-text").textContent).toContain("1:const a = 1;");
  });
});

describe("ast_edit details as omp v18.12.6 builds them", () => {
  test("parse errors are strings: omp keeps `path: parse error ...` lines, capped, with the total", () => {
    // `packages/coding-agent/src/tools/ast-edit.ts:303,324-336`; `packages/tui/src/tools/ast-edit.ts:30-52`
    // (`parseErrors?: string[]`); the line itself is built at `crates/pi-natives/src/ast.rs:836-839`.
    const parseError = "src/bad.ts: parse error (syntax tree contains error nodes)";
    const args = { ops: [{ pat: "console.log($A)", out: "logger.info($A)" }], paths: ["src"] };
    render(
      <AstEditCard
        rendererProps={toolProps(
          "ast_edit",
          args,
          {
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: 12,
            applied: false,
            limitReached: false,
            parseErrors: [parseError],
            parseErrorsTotal: 3,
            scopePath: "src",
            searchPath: "/work/src",
            cwd: "/work",
            files: [],
            fileReplacements: [],
          },
          `No replacements made\nParse issues (1 / 3):\n- ${parseError}`,
        )}
      />,
    );
    expandToolCards();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Parse errors (3)");
    expect(alert.textContent).toContain(parseError);
    expect(screen.queryByText(/details were malformed/)).toBeNull();
  });
});
