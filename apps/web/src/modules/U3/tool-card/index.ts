/**
 * The public surface of the U3 tool-card core: the state contract, the normalizer, the shared card shell, the registry
 * resolver, the generic fallback, the nested transcript and the bash card. T1 to T7 renderers import from here only.
 */

export type { BashCardProps } from "./bash";
export { BashCard, BashToolRenderer, U3_BASH_DESCRIPTOR } from "./bash";
export type { ToolCardOutcome, ToolCardProps } from "./card";
export { copyStatusText, ToolCard } from "./card";
export type {
  NestedTranscriptSource,
  NormalizeToolCallInput,
  OutputMeta,
  OutputRange,
  ToolCardError,
  ToolCardPhase,
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRenderer,
  ToolRendererProps,
  TruncationDirection,
  TruncationMeta,
  TruncationReason,
} from "./contract";
export { ToolFallback } from "./fallback";
export type { NestedTranscriptProps } from "./nested";
export { MAX_NESTED_TRANSCRIPT_DEPTH, NestedTranscript } from "./nested";
export type { ToolStateSource } from "./normalize";
export { normalizeToolCall, normalizeToolRendererProps } from "./normalize";
export type { ToolRegistry, ToolResolution } from "./registry";
export { createToolRegistry } from "./registry";
export type {
  ArtifactSlot,
  ArtifactSlotProps,
  CopyKind,
  CopySlot,
  CopySlotProps,
  DiffSlot,
  DiffSlotProps,
  RawResultSlot,
  RawResultSlotProps,
} from "./slots";
