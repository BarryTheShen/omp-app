import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { normalizeReflect } from "./models";

export function ReflectRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeReflect(props.args, props.result);
  const summary = model.query
    ? model.query.replace(/\s+/g, " ").trim().slice(0, 96)
    : "Memory reflection";
  return (
    <div data-t6-memory-card data-t6-tool="reflect">
      <ToolCard rawResult={model.answer.text} state={state} summary={summary}>
        <div className="border-border/60 bg-background ms-2 mt-1 rounded-md border px-3 py-2 text-sm">
          {model.noInformation ? (
            <p className="text-muted-foreground">No relevant information found.</p>
          ) : model.answer.text.length === 0 ? (
            <p className="text-muted-foreground">No synthesized answer returned.</p>
          ) : (
            <MarkdownContent text={model.answer.text} variant="compact" />
          )}
          {model.answer.truncated && (
            <p className="text-muted-foreground mt-2 text-xs">Reflection preview truncated.</p>
          )}
        </div>
      </ToolCard>
    </div>
  );
}
