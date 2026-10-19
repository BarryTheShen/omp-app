/**
 * One tool call and the result omp recorded for it in a session file, with private paths and
 * content replaced. Cards are built against these, never against hand-written shapes: omp's real
 * result is `{ content: [{ type: "text", text }], details }`, and `details` differs per tool.
 *
 * Produce new samples from a real session store with `bun tools/extract-tool-samples.ts`.
 */
export interface RealToolResult {
  /** "read: a long file, cut at omp's limit": the tool, then the shape this sample stands for. */
  readonly name: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: { readonly content: readonly unknown[]; readonly details?: unknown };
  /** omp marked the result as a failure. */
  readonly isError: boolean;
  /** The muted marker shown for an omp synthetic interruption or skipped call. */
  readonly reads?: "interrupted" | "skipped";
  /** Text the finished card must show: the facts a person needs from this result. */
  readonly shows: readonly string[];
}
