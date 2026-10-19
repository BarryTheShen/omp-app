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
    .filter((line) => line.length > 0);
}

function recallHeader(lines: readonly string[]): string | undefined {
  const first = lines[0];
  return first !== undefined && /^Found \d+ relevant memories?\b/.test(first) ? first : undefined;
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
  const header = recallHeader(lines);
  const memories = header === undefined ? lines.slice(0, 8) : lines.slice(1, 9);
  const hiddenCount =
    model.count !== null && model.count > memories.length ? model.count - memories.length : 0;
  return (
    <div data-t6-memory-card data-t6-tool="recall">
      <ToolCard rawResult={model.content.text} state={state} summary={summary}>
        {model.noMatch ? (
          <p className="text-muted-foreground py-1 text-xs">No memories found.</p>
        ) : (
          <>
            {header !== undefined && <p className="text-muted-foreground py-1 text-xs">{header}</p>}
            <ul className="text-muted-foreground list-disc space-y-1 py-1 ps-5 text-xs">
              {memories.length === 0 ? (
                <li>No memory text returned.</li>
              ) : (
                memories.map((line) => <li key={line}>{line}</li>)
              )}
            </ul>
            {hiddenCount > 0 && (
              <p className="text-muted-foreground py-1 text-xs">
                Showing {memories.length} of {model.count} memories.
              </p>
            )}
          </>
        )}
        {model.content.truncated && (
          <p className="text-muted-foreground text-xs">Memory preview truncated.</p>
        )}
      </ToolCard>
    </div>
  );
}
