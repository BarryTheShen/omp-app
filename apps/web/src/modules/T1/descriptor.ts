import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { AstEditToolRenderer } from "./ast-edit";
import { EditToolRenderer } from "./edit";
import { ReadToolRenderer } from "./read";
import { WriteToolRenderer } from "./write";
/** T1 owns five exact file-operation tool claims; read also covers T4's URL-read inventory row. */
export const T1_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T1.applyPatchRendererAlias",
    owner: "T1",
    title: "Apply patch",
    covers: ["T1.apply-patch-renderer-alias"],
    requires: [],
    match: { by: "name", name: "apply_patch" },
    renderer: EditToolRenderer,
  },
  {
    kind: "tool",
    id: "T1.astEdit",
    owner: "T1",
    title: "AST edit",
    covers: ["T1.ast-edit"],
    requires: [],
    match: { by: "name", name: "ast_edit" },
    renderer: AstEditToolRenderer,
  },
  {
    kind: "tool",
    id: "T1.edit",
    owner: "T1",
    title: "Edit",
    covers: ["T1.edit"],
    requires: [],
    match: { by: "name", name: "edit" },
    renderer: EditToolRenderer,
  },
  {
    kind: "tool",
    id: "T1.read",
    owner: "T1",
    title: "Read",
    covers: ["T1.read", "T4.fetch-read-url-path"],
    requires: [],
    match: { by: "name", name: "read" },
    renderer: ReadToolRenderer,
  },
  {
    kind: "tool",
    id: "T1.write",
    owner: "T1",
    title: "Write",
    covers: ["T1.write"],
    requires: [],
    match: { by: "name", name: "write" },
    renderer: WriteToolRenderer,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T1ToolDescriptor = (typeof T1_TOOL_DESCRIPTORS)[number];
