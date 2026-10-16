/**
 * T1's public surface: the five file-operation descriptors (`read` also covers the T4 URL row), the typed detail models,
 * the read-to-URL seam and the renderers. The central registry will compose T1 from here, once it is switched; until then
 * its two deep imports still resolve.
 */

export type { OutputMeta } from "../U3/tool-card/output-meta";
export { AstEditToolRenderer } from "./ast-edit";
export { T1_TOOL_DESCRIPTORS, type T1ToolDescriptor } from "./descriptor";
export { EditToolRenderer } from "./edit";
export {
  type ArtifactNotice,
  ArtifactNoticeSchema,
  type AstEditToolArgs,
  type AstEditToolDetails,
  type DetailDecode,
  type Diagnostic,
  DiagnosticSchema,
  decodeAstEditArgs,
  decodeAstEditDetails,
  decodeEditArgs,
  decodeEditDetails,
  decodeReadArgs,
  decodeReadDetails,
  decodeWriteArgs,
  decodeWriteDetails,
  type EditPerFileResult,
  type EditToolArgs,
  type EditToolDetails,
  type ReadDisplayContent,
  type ReadSummary,
  type ReadToolArgs,
  type ReadToolDetails,
  type WriteToolArgs,
  type WriteToolDetails,
} from "./models";
export { createReadToolRenderer, ReadToolRenderer } from "./read";
export { dispatchReadUrl, type ReadUrlRenderer, type ReadUrlRendererProps } from "./read-url-seam";
export { WriteToolRenderer } from "./write";
