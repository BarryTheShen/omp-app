import { cn } from "cn";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { normalizeRetain } from "./models";

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

export function RetainRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeRetain(props.args, props.result);
  const failed = model.details?.failed ?? [];
  const summary =
    model.status === "partial" && model.details?.stored !== undefined && model.count !== null
      ? `Stored ${model.details.stored} of ${model.count} memories`
      : itemCountLabel(model.count, model.status);
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
        state={state}
        summary={summary}
        summaryClassName={partial ? "text-warning font-medium" : undefined}
      />
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
                {failure === undefined ? (
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
      {model.malformed && (
        <p className="text-muted-foreground ms-2 text-xs">Some memory details were malformed.</p>
      )}
    </div>
  );
}
