import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeManageSkillArgs, normalizeManageSkill } from "./models";

export function ManageSkillRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = normalizeManageSkill(props.args, props.result);
  const decoded = decodeManageSkillArgs(props.args);
  const body = decoded.value?.body;
  const summary = model.name.length > 0 ? `${model.action}: ${model.name}` : "Skill management";
  return (
    <div data-t6-memory-card data-t6-tool="manage_skill">
      <ToolCard rawResult={JSON.stringify(model.raw)} state={state} summary={summary} />
      <div className="text-muted-foreground ms-2 py-1 text-xs">
        <p className="text-foreground">
          {model.name.length > 0 ? `${model.action} ${model.name}` : "Skill name unavailable"}
        </p>
        {model.status !== "unknown" && <p className="mt-1">Status: {model.status}</p>}
        {body !== undefined && body.length > 0 && (
          <div className="mt-1 text-sm">
            <MarkdownContent text={body} variant="compact" />
          </div>
        )}
        {model.malformed && <p className="mt-1">Some skill details were malformed.</p>}
      </div>
    </div>
  );
}
