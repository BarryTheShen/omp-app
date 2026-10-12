import { cn } from "cn";
import { AlertCircleIcon, CheckCircle2Icon, CircleIcon } from "lucide-react";
import { z } from "zod";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { normalizeRetain, type RetainModel } from "./models";

function itemCountLabel(
  count: number | null,
  status: "stored" | "queued" | "partial" | "unknown",
): string {
  const value = count ?? 0;
  if (status === "stored") return `Stored ${value} ${value === 1 ? "memory" : "memories"}`;
  if (status === "queued") return `Queued ${value} ${value === 1 ? "memory" : "memories"}`;
  if (status === "partial")
    return `Stored ${value} ${value === 1 ? "memory" : "memories"} with failures`;
  return value === 0 ? "No memories stored" : `${value} memories returned`;
}

function failureLabel(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 180);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["reason", "message", "error", "content"]) {
      if (typeof record[key] === "string" && record[key].trim().length > 0)
        return record[key].trim().slice(0, 180);
    }
  }
  return "Memory item failed without a safe detail.";
}

function failureIndex(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["index", "itemIndex"]) {
    if (typeof record[key] === "number" && Number.isInteger(record[key])) return record[key];
  }
  return undefined;
}

const RetainErrorDetailsSchema = z.looseObject({ error: z.string().optional() });

/** omp's own message for a call that failed: its `details.error`, else the text it returned. */
function failedCallMessage(split: { readonly text: string; readonly details: unknown }): string {
  const parsed = RetainErrorDetailsSchema.safeParse(split.details);
  return parsed.success && parsed.data.error !== undefined ? parsed.data.error : split.text;
}

/** The card's one-line summary: omp's own words when its details do not say stored, queued or failed. */
function retainSummary(model: RetainModel, failedCall: boolean, resultText: string): string {
  if (failedCall) return "Retain failed";
  if (model.status === "partial" && model.details?.stored !== undefined && model.count !== null)
    return `Stored ${model.details.stored} of ${model.count} memories`;
  if (model.status === "unknown" && resultText !== "")
    return resultText.split("\n")[0] ?? resultText;
  return itemCountLabel(model.count, model.status);
}

export function RetainRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeRetain(props.args, props.result);
  const failedCall = state.phase === "error";
  const unrecorded = state.phase === "unrecorded";
  const split = splitToolResult(props.result ?? state.result ?? state.partialResult);
  const callMessage = failedCallMessage(split);
  const resultText = split.text.trim();
  const cardState = failedCall
    ? { ...state, error: { message: callMessage, retryable: false } }
    : state;
  const failed = model.details?.failed ?? [];
  const summary = retainSummary(model, failedCall, resultText);
  const partial = model.status === "partial";
  const itemFailures = new Map<number, unknown>();
  const unindexedFailures: unknown[] = [];
  for (const failure of failed) {
    const index = failureIndex(failure);
    if (index === undefined) unindexedFailures.push(failure);
    else itemFailures.set(index, failure);
  }
  const fallbackStart = Math.max(0, model.items.length - unindexedFailures.length);
  return (
    <div data-t6-memory-card data-t6-tool="retain">
      <ToolCard
        rawResult={JSON.stringify(model.raw)}
        state={cardState}
        summary={summary}
        summaryClassName={partial ? "text-warning font-medium" : undefined}
      >
        {!failedCall && (
          <ul className="text-muted-foreground ms-2 space-y-1 py-1 ps-5 text-xs">
            {model.items.length === 0 ? (
              <li>No memory items returned.</li>
            ) : (
              model.items.map((item, index) => {
                const failure =
                  itemFailures.get(index) ??
                  (index >= fallbackStart ? unindexedFailures[index - fallbackStart] : undefined);
                return (
                  <li
                    className={cn("flex items-start gap-1", failure !== undefined && "text-danger")}
                    key={`${item.scope ?? "unknown"}:${item.content}`}
                  >
                    {unrecorded ? (
                      <CircleIcon
                        aria-hidden="true"
                        className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                      />
                    ) : failure === undefined ? (
                      <CheckCircle2Icon
                        aria-hidden="true"
                        className="text-success mt-0.5 size-3.5 shrink-0"
                      />
                    ) : (
                      <AlertCircleIcon
                        aria-hidden="true"
                        className="text-danger mt-0.5 size-3.5 shrink-0"
                      />
                    )}
                    <span className="min-w-0">
                      <span className={failure === undefined ? "text-foreground" : undefined}>
                        {item.content}
                      </span>
                      {item.scope !== undefined && <span className="ms-1">({item.scope})</span>}
                      {item.context !== undefined && <p className="truncate">{item.context}</p>}
                      {failure !== undefined && <p className="mt-0.5">{failureLabel(failure)}</p>}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        )}
        {unindexedFailures.length > model.items.length && (
          <p className="text-danger ms-2 text-xs">
            {unindexedFailures.length - model.items.length} additional memory failures returned.
          </p>
        )}
        {model.status === "queued" && (
          <p className="text-muted-foreground ms-2 text-xs">
            The memory operation is queued; storage is not confirmed yet.
          </p>
        )}
        {model.malformed && !failedCall && (
          <p className="text-muted-foreground ms-2 text-xs">Some memory details were malformed.</p>
        )}
      </ToolCard>
    </div>
  );
}
