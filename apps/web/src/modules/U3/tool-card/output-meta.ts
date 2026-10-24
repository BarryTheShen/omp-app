import { z } from "zod";

const UnknownRecord = z.record(z.string(), z.unknown());

/** A range of lines: `{ start, end }`. */
export const OutputRangeSchema = z.looseObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});
export type OutputRange = z.infer<typeof OutputRangeSchema>;

/**
 * omp's truncation record, as it is really sent (`details.truncation` and `details.meta.truncation`;
 * omp v18.6.1 `tools/output-meta.ts`): `{ truncated, direction, truncatedBy, totalLines, totalBytes,
 * outputLines, outputBytes, maxBytes, shownRange, headRange, tailRange, nextOffset, elidedLines,
 * elidedBytes, artifactId, ... }`. Every field is optional: a card shows what is there.
 */
export const TruncationMetaSchema = z.looseObject({
  truncated: z.boolean().optional(),
  direction: z.enum(["head", "tail", "middle"]).optional(),
  truncatedBy: z.enum(["lines", "bytes", "middle"]).optional(),
  totalLines: z.int().nonnegative().optional(),
  totalBytes: z.int().nonnegative().optional(),
  outputLines: z.int().nonnegative().optional(),
  outputBytes: z.int().nonnegative().optional(),
  maxBytes: z.int().nonnegative().optional(),
  shownRange: OutputRangeSchema.optional(),
  headRange: OutputRangeSchema.optional(),
  tailRange: OutputRangeSchema.optional(),
  nextOffset: z.int().nonnegative().optional(),
  elidedLines: z.int().nonnegative().optional(),
  elidedBytes: z.int().nonnegative().optional(),
  artifactId: z.string().min(1).optional(),
  lastLinePartial: z.boolean().optional(),
  firstLineExceedsLimit: z.boolean().optional(),
});
export type TruncationMeta = z.infer<typeof TruncationMetaSchema>;

/** How many lines and bytes a real truncation record says were left out (undefined when it does not say). */
export function omittedOf(truncation: TruncationMeta): {
  readonly lines: number | undefined;
  readonly bytes: number | undefined;
} {
  const lines =
    truncation.elidedLines ??
    (truncation.totalLines !== undefined && truncation.outputLines !== undefined
      ? Math.max(0, truncation.totalLines - truncation.outputLines)
      : undefined);
  const bytes =
    truncation.elidedBytes ??
    (truncation.totalBytes !== undefined && truncation.outputBytes !== undefined
      ? Math.max(0, truncation.totalBytes - truncation.outputBytes)
      : undefined);
  return { lines, bytes };
}

/** Where a result came from: `{ type: "path" | "url" | "report" | ..., value }`. */
export const OutputSourceSchema = z.looseObject({
  type: z.string(),
  value: z.string().optional(),
});

/**
 * The LSP diagnostics an edit or a write attached, as omp's `OutputMetaBuilder.diagnostics` stores them: the summary
 * and the message lines, one object, not a list (omp v18.12.6 `packages/tui/src/tools/output-meta.ts:53-56,92`,
 * `packages/coding-agent/src/tools/output-meta.ts:425-430`). The builder adds nothing when there are no messages.
 */
export const OutputDiagnosticsSchema = z.looseObject({
  summary: z.string(),
  messages: z.array(z.string()),
});
export type OutputDiagnostics = z.infer<typeof OutputDiagnosticsSchema>;

/**
 * `details.meta` of a tool result, the wire shape every tool module decodes. (`OutputMeta` in
 * `contract.ts` is a card's normalized view of it.)
 */
export const OutputMetaSchema = z.looseObject({
  truncation: TruncationMetaSchema.optional(),
  source: OutputSourceSchema.optional(),
  artifactId: z.string().min(1).optional(),
  artifactElidedBytes: z.int().nonnegative().optional(),
  artifactError: UnknownRecord.optional(),
  diagnostics: OutputDiagnosticsSchema.optional(),
  /** What cut the output short beyond truncation, such as `{ resultLimit: { reached: 200 } }`. */
  limits: UnknownRecord.optional(),
});
export type OutputMeta = z.infer<typeof OutputMetaSchema>;
