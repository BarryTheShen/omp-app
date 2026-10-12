import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { normalizeMemoryEdit } from "./models";

function operationLabel(operation: string): string {
  if (operation === "update") return "Updated memory";
  if (operation === "forget") return "Forgot memory";
  if (operation === "invalidate") return "Invalidated memory";
  return "Memory edit";
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
  const label = operationLabel(model.operation);
  const summary = model.id.length > 0 ? `${label}: ${model.id}` : label;
  const confirmation = model.status.length > 0 ? model.status : resultText(props.result);
  return (
    <div data-t6-memory-card data-t6-tool="memory_edit">
      <ToolCard rawResult={JSON.stringify(model.raw)} state={state} summary={summary}>
        <div className="text-muted-foreground ms-2 py-1 text-xs">
          <p className="text-foreground">{summary}</p>
          {confirmation.length > 0 && <p className="mt-1">Confirmation: {confirmation}</p>}
          {model.malformed && <p className="mt-1">Some memory edit details were malformed.</p>}
        </div>
      </ToolCard>
    </div>
  );
}
