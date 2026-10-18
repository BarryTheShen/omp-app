import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeLearnArgs, normalizeLearn } from "./models";

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

export function LearnRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeLearn(props.args, props.result);
  const decoded = decodeLearnArgs(props.args);
  const skillBody = decoded.value?.skill?.body;
  const summary = model.memory
    ? `Learned${model.scope === undefined ? "" : ` · ${model.scope}`}`
    : "Memory lesson";
  const result = resultText(props.result);
  return (
    <div data-t6-memory-card data-t6-tool="learn">
      <ToolCard rawResult={JSON.stringify(model.raw)} state={state} summary={summary}>
        <div className="text-muted-foreground py-1 text-xs">
          {model.memory.length > 0 ? (
            <p className="text-foreground">{model.memory}</p>
          ) : (
            <p>No memory lesson returned.</p>
          )}
          {model.skill?.name !== undefined && (
            <p className="mt-1">
              Skill {model.skill.action ?? "change"}: {model.skill.name} ({model.skillStatus})
            </p>
          )}
          {skillBody !== undefined && skillBody.length > 0 && (
            <div className="mt-1 text-sm">
              <MarkdownContent text={skillBody} variant="compact" />
            </div>
          )}
          {result.length > 0 && model.memory.length === 0 && (
            <p className="mt-1 truncate">{result}</p>
          )}
          {model.malformed && <p className="mt-1">Some lesson details were malformed.</p>}
        </div>
      </ToolCard>
    </div>
  );
}
