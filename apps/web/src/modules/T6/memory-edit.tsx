import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { normalizeMemoryEdit } from "./models";

function operationSummary(operation: string, phase: string): string {
  if (phase === "running") return "Editing memory…";
  if (phase === "partial") return "Memory edit in progress";
  if (phase === "cancelled") return "Memory edit cancelled";
  if (phase === "error") return "Memory edit failed";
  switch (operation) {
    case "update":
      return "Update memory";
    case "forget":
      return "Forget memory";
    case "invalidate":
      return "Invalidate memory";
    default:
      return "Edit memory";
  }
}

function resultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "content" in raw) {
    const content = raw.content;
    if (Array.isArray(content))
      return content
        .filter(
          (item): item is { readonly text: string } =>
            item !== null &&
            typeof item === "object" &&
            "text" in item &&
            typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n");
  }
  return "";
}

export function MemoryEditRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeMemoryEdit(props.args, props.result);
  const summary = operationSummary(model.operation, state.phase);
  const result = resultText(props.result);
  const fallbackStatus =
    model.status === "updated"
      ? "Memory updated."
      : model.status === "forgotten"
        ? "Memory forgotten."
        : model.status === "invalidated"
          ? "Memory invalidated."
          : "";
  const message = result || fallbackStatus;
  return (
    <div data-t6-memory-card data-t6-tool="memory_edit">
      <ToolCard rawResult={JSON.stringify(model.raw)} state={state} summary={summary}>
        <div className="text-muted-foreground py-1 text-xs">
          {state.phase !== "error" && message.length > 0 && (
            <p className="text-foreground">{message}</p>
          )}
          {model.malformed && <p className="mt-1">Some memory edit details were malformed.</p>}
        </div>
      </ToolCard>
    </div>
  );
}
