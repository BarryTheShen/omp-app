import type { MessageDescriptor } from "@omp-app/contracts";
import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { ToolFallback } from "../U3/tool-card/fallback";
import { FindToolRenderer } from "./find";
import { GlobToolRenderer } from "./glob";

/** T2 owns five search/code-intelligence tool claims and one late diagnostic message claim. */
export const T2_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T2.astGrep",
    owner: "T2",
    title: "AST grep",
    covers: ["T2.ast-grep"],
    requires: [],
    match: { by: "name", name: "ast_grep" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T2.semanticFind",
    owner: "T2",
    title: "Semantic search",
    covers: ["T2.find-legacy-alias-to-glob"],
    requires: [],
    match: { by: "name", name: "find" },
    renderer: FindToolRenderer,
  },
  {
    kind: "tool",
    id: "T2.glob",
    owner: "T2",
    title: "Glob",
    covers: ["T2.glob"],
    requires: [],
    match: { by: "name", name: "glob" },
    renderer: GlobToolRenderer,
  },
  {
    kind: "tool",
    id: "T2.grep",
    owner: "T2",
    title: "Grep",
    covers: ["T2.grep"],
    requires: [],
    match: { by: "name", name: "grep" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T2.lsp",
    owner: "T2",
    title: "Language server",
    covers: ["T2.lsp"],
    requires: [],
    match: { by: "name", name: "lsp" },
    renderer: ToolFallback,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export const T2_MESSAGE_DESCRIPTORS = [
  {
    kind: "message",
    id: "T2.lateLspDiagnostics",
    owner: "T2",
    title: "Late LSP diagnostics",
    covers: ["T2.late-lsp-diagnostics"],
    requires: [],
    match: { by: "customType", customType: "lsp-late-diagnostic" },
  },
] as const satisfies readonly MessageDescriptor[];

export const T2_DESCRIPTORS = [...T2_TOOL_DESCRIPTORS, ...T2_MESSAGE_DESCRIPTORS] as const;

export type T2ToolDescriptor = (typeof T2_TOOL_DESCRIPTORS)[number];
export type T2MessageDescriptor = (typeof T2_MESSAGE_DESCRIPTORS)[number];
