import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * Results whose shape is read from omp v18.8.9 source. No recorded `apply_patch` result was found in the owner's session store,
 * checked 2026-10-15. One recorded `ast_edit` result exists (the no-op in real-results.ts); other cases below are source-built.
 * `citation` names the code. The envelope, keys, `isError` flag, and every text are omp's; paths, counts, and file contents are invented.
 */
export interface OmpSourceResult extends RealToolResult {
  /** The omp v18.8.9 file and lines that build this result. */
  readonly citation: string;
  /** A known defect the card exposes; only that fixture's placeholder check is marked until it is fixed. */
  readonly knownIssue?: string;
}

const PATCH_ONE_FILE =
  "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-  const retries = 2;\n+  const retries = 3;\n*** End Patch";

const PATCH_TWO_FILES =
  "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-  const retries = 2;\n+  const retries = 3;\n*** Update File: src/retry.ts\n@@\n-export const retries = 2;\n+export const retries = 3;\n*** End Patch";

/** The text the engine writes for the first file of PATCH_ONE_FILE: the header, then the numbered preview of the change. */
const APP_TEXT =
  "[src/app.ts]\n1:export function run() {\n2:  const retries = 3;\n3:  return retries;\n4:}";

/** The text the engine writes for the second file of PATCH_TWO_FILES. */
const RETRY_TEXT = "[src/retry.ts]\n1:export const retries = 3;";

const APP_DIFF =
  "@@ -1,4 +1,4 @@\n 1|export function run() {\n-2|  const retries = 2;\n+2|  const retries = 3;\n 3|  return retries;\n 4|}";

const RETRY_DIFF = "@@ -1,1 +1,1 @@\n-1|export const retries = 2;\n+1|export const retries = 3;";

const APP_OLD = "export function run() {\n  const retries = 2;\n  return retries;\n}\n";
const APP_NEW = "export function run() {\n  const retries = 3;\n  return retries;\n}\n";

/** The notice omp puts first on a preview that is not applied: PREVIEW_PENDING_NOTICE, with the device paths it names. */
const PREVIEW_NOTICE =
  "Staged as a proposal — files NOT modified yet. To apply: write a one-sentence reason to xd://resolve. To discard: write to xd://reject.";

/** The args of an ast_edit call: the op list, the paths, and the intent omp adds to each call (as in the recorded no-op). */
const AST_ARGS = {
  i: "Modernize the legacy calls",
  ops: [{ pat: "legacyCall($$$ARGS)", out: "modernCall($$$ARGS)" }],
  paths: ["src/**/*.ts"],
};

const APPLY_PATCH_CITE =
  'crates/pi-edit/src/session.rs:370-381 (header), :428-433 (files joined with EDIT_RESULT_SEPARATOR, "\\n\\n" at :120), :491-517 (format_file_text), :399-409 (oldText/newText); crates/pi-edit/src/modes/patch.rs:1381-1403 (diff, preview_diff, header Path); crates/pi-edit/src/diff_string.rs:262-330 (numbered preview rows), :375-418 (unified @@ rows), :732-783 (compact preview); packages/coding-agent/src/edit/index.ts:220-270 (per-file and aggregate details), :510-514 (success envelope)';

/**
 * These synthetic ast_edit previews use omp's grouped model text and per-file counts, with hashline mode disabled: their
 * `-N:C` / `+N:C` refs lack the `#TAG` headers emitted when hashline mode is enabled (`ast-edit.ts:346-362, 379-385,
 * 390-404`; `packages/utils/src/path-tree.ts:67-119`). Omp also sends `displayContent` (`ast-edit.ts:536-541`), but the
 * T1 card does not read it, so it is deliberately omitted.
 */
export const T1_OMP_SOURCE_RESULTS: readonly OmpSourceResult[] = [
  {
    name: "apply_patch: one file, one line changed",
    toolName: "apply_patch",
    args: { input: PATCH_ONE_FILE },
    result: {
      content: [{ type: "text", text: APP_TEXT }],
      details: {
        diff: APP_DIFF,
        firstChangedLine: 2,
        op: "update",
        path: "src/app.ts",
        oldText: APP_OLD,
        newText: APP_NEW,
      },
    },
    isError: false,
    shows: ["src/app.ts", "const retries = 3;"],
    citation: APPLY_PATCH_CITE,
  },
  {
    name: "apply_patch: two files, both updated in one patch",
    toolName: "apply_patch",
    args: { input: PATCH_TWO_FILES },
    result: {
      content: [{ type: "text", text: `${APP_TEXT}\n\n${RETRY_TEXT}` }],
      details: {
        diff: `${APP_DIFF}\n${RETRY_DIFF}`,
        firstChangedLine: 2,
        perFileResults: [
          {
            path: "src/app.ts",
            diff: APP_DIFF,
            firstChangedLine: 2,
            op: "update",
            oldText: APP_OLD,
            newText: APP_NEW,
          },
          {
            path: "src/retry.ts",
            diff: RETRY_DIFF,
            firstChangedLine: 1,
            op: "update",
            oldText: "export const retries = 2;\n",
            newText: "export const retries = 3;\n",
          },
        ],
      },
    },
    isError: false,
    shows: ["src/retry.ts", "src/app.ts"],
    citation: APPLY_PATCH_CITE,
  },
  {
    name: "apply_patch: the patch does not apply, so no file changes",
    toolName: "apply_patch",
    args: {
      input:
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-throw new Error('unrelated');\n+throw new Error('retry');\n*** End Patch",
    },
    result: {
      content: [
        {
          type: "text",
          text: "Failed to find expected lines in src/app.ts:\nthrow new Error('unrelated');",
        },
      ],
    },
    isError: true,
    shows: ["Failed to find expected lines in src/app.ts:"],
    citation:
      'crates/pi-edit/src/modes/patch.rs:872-874 ("Failed to find expected lines in {path}:\\n{old_text}", used when no line is close enough; the close-match form is at :863-870); packages/coding-agent/src/edit/index.ts:506-507 (error envelope: text and isError, no details)',
  },
  {
    name: "apply_patch: a two-file patch where one file does not match",
    toolName: "apply_patch",
    args: {
      input:
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-throw new Error('unrelated');\n+throw new Error('retry');\n*** Update File: src/retry.ts\n@@\n-export const retries = 2;\n+export const retries = 3;\n*** End Patch",
    },
    result: {
      content: [
        {
          type: "text",
          text: "[src/app.ts]: Failed to find expected lines in src/app.ts:\nthrow new Error('unrelated');\nNo files were modified — sections apply atomically.",
        },
      ],
    },
    isError: true,
    shows: [
      "[src/app.ts]: Failed to find expected lines in src/app.ts:",
      "No files were modified — sections apply atomically.",
    ],
    citation:
      "crates/pi-edit/src/modes/apply_patch.rs:28, 253-262 (atomicity notice and multi-file error wrapper); crates/pi-edit/src/modes/patch.rs:872-874 (missing lines); packages/coding-agent/src/edit/index.ts:506-507 (error envelope)",
  },
  {
    name: "ast_edit: a preview of two replacements in one file",
    toolName: "ast_edit",
    args: AST_ARGS,
    result: {
      content: [
        {
          type: "text",
          text: [
            PREVIEW_NOTICE,
            "",
            "# src/",
            "## app.ts (2 replacements)",
            "-10:3 legacyCall(a0)",
            "+10:3 modernCall(a0)",
            "-14:5 legacyCall(b0)",
            "+14:5 modernCall(b0)",
          ].join("\n"),
        },
      ],
      details: {
        totalReplacements: 2,
        filesTouched: 1,
        filesSearched: 3,
        applied: false,
        limitReached: false,
        scopePath: "src",
        searchPath: "/workspace/src",
        cwd: "/workspace",
        files: ["src/app.ts"],
        fileReplacements: [{ path: "src/app.ts", count: 2 }],
      },
    },
    isError: false,
    shows: ["2 replacements", "1 file"],
    knownIssue: "issue 1703",
    citation:
      "packages/coding-agent/src/tools/ast-edit.ts:346-362 (hashline-off refs), :379-385 (model lines), :390-404 (grouped output), :533 (proposal notice), :536-541 (counts and displayContent); packages/tui/src/tools/grouped-file-output.ts:52-92; packages/utils/src/path-tree.ts:67-119",
  },
  {
    name: "ast_edit: a large preview, with many replacements in five files",
    toolName: "ast_edit",
    args: AST_ARGS,
    result: {
      content: [
        {
          type: "text",
          text: [
            PREVIEW_NOTICE,
            "",
            "# src/",
            ...["a", "b", "c", "d", "e"].flatMap((file, fileIndex) => [
              `## ${file}.ts (${fileIndex === 0 ? 8 : 7} replacements)`,
              ...Array.from({ length: fileIndex === 0 ? 8 : 7 }, (_, index) => [
                `-${index + 1}:3 legacyCall(f${fileIndex}-${index})`,
                `+${index + 1}:3 modernCall(f${fileIndex}-${index})`,
              ]).flat(),
            ]),
          ].join("\n"),
        },
      ],
      details: {
        totalReplacements: 36,
        filesTouched: 5,
        filesSearched: 12,
        applied: false,
        limitReached: false,
        scopePath: "src",
        searchPath: "/workspace/src",
        cwd: "/workspace",
        files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        fileReplacements: [
          { path: "src/a.ts", count: 8 },
          { path: "src/b.ts", count: 7 },
          { path: "src/c.ts", count: 7 },
          { path: "src/d.ts", count: 7 },
          { path: "src/e.ts", count: 7 },
        ],
      },
    },
    isError: false,
    shows: ["36 replacements", "5 files"],
    knownIssue: "issue 1703",
    citation:
      "packages/coding-agent/src/tools/ast-edit.ts:346-362 (hashline-off refs), :379-385 (model lines), :390-404 (grouped output), :533 (proposal notice), :536-541 (counts and displayContent); packages/tui/src/tools/grouped-file-output.ts:52-92; packages/utils/src/path-tree.ts:67-119",
  },
  {
    name: "ast_edit: the search stopped at its file limit",
    toolName: "ast_edit",
    args: AST_ARGS,
    result: {
      content: [
        {
          type: "text",
          text: [
            PREVIEW_NOTICE,
            "",
            "# src/",
            "## a.ts (1 replacement)",
            "-10:3 legacyCall(a0)",
            "+10:3 modernCall(a0)",
            "",
            "Limit reached; narrow paths.",
          ].join("\n"),
        },
      ],
      details: {
        totalReplacements: 1,
        filesTouched: 1,
        filesSearched: 300,
        applied: false,
        limitReached: true,
        scopePath: "src",
        searchPath: "/workspace/src",
        cwd: "/workspace",
        files: ["src/a.ts"],
        fileReplacements: [{ path: "src/a.ts", count: 1 }],
      },
    },
    isError: false,
    shows: ["Match list truncated by a safety limit; some files may not be shown."],
    knownIssue: "issue 1703",
    citation:
      "packages/coding-agent/src/tools/ast-edit.ts:346-362 (hashline-off refs), :390-404 (grouped output), :426-428 (limit text), :533 (proposal notice), :536-541 (counts and displayContent); packages/tui/src/tools/grouped-file-output.ts:52-92; packages/utils/src/path-tree.ts:67-119",
  },
  {
    name: "ast_edit: a rewrite pattern given twice",
    toolName: "ast_edit",
    args: {
      i: "Modernize the legacy calls",
      ops: [
        { pat: "legacyCall($$$ARGS)", out: "modernCall($$$ARGS)" },
        { pat: "legacyCall($$$ARGS)", out: "modernCall($$$ARGS)" },
      ],
      paths: ["src/**/*.ts"],
    },
    result: {
      content: [{ type: "text", text: "Duplicate rewrite pattern: legacyCall($$$ARGS)" }],
      details: {},
    },
    isError: true,
    shows: ["Duplicate rewrite pattern: legacyCall($$$ARGS)"],
    citation:
      "packages/coding-agent/src/tools/ast-edit.ts:262-264 (duplicate pattern ToolError); packages/agent/src/agent-loop.ts:3591-3598 (a thrown error becomes a result with content [{type: text, text: e.message}], details {}, isError true)",
  },
];
