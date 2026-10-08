import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { normalizeRecall } from "./models";

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}…` : normalized;
}

function resultLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^- /, ""))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

export function RecallRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeRecall(props.args, props.result);
  const summary = model.query
    ? oneLine(model.query)
    : model.noMatch
      ? "No memories found"
      : model.count === null
        ? "Memory results"
        : `${model.count} memor${model.count === 1 ? "y" : "ies"}`;
  const lines = resultLines(model.content.text);
  return (
    <div data-t6-memory-card data-t6-tool="recall">
      <ToolCard rawResult={model.content.text} state={state} summary={summary} />
      {model.noMatch ? (
        <p className="text-muted-foreground ms-2 py-1 text-xs">No memories found.</p>
      ) : (
        <ul className="text-muted-foreground ms-2 list-disc space-y-1 py-1 ps-5 text-xs">
          {lines.length === 0 ? (
            <li>No memory text returned.</li>
          ) : (
            lines.map((line) => <li key={line}>{line}</li>)
          )}
        </ul>
      )}
      {model.content.truncated && (
        <p className="text-muted-foreground ms-2 text-xs">Memory preview truncated.</p>
      )}
    </div>
  );
}
