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
  const summary =
    state.phase === "running"
      ? "Managing skill…"
      : state.phase === "partial"
        ? "Skill change in progress"
        : state.phase === "cancelled"
          ? "Skill change cancelled"
          : state.phase === "error"
            ? "Skill change failed"
            : "Manage skill";
  const outcome =
    model.name.length === 0
      ? "No skill name was given."
      : model.status === "created"
        ? `Created managed skill "${model.name}".`
        : model.status === "updated"
          ? `Updated managed skill "${model.name}".`
          : model.status === "deleted"
            ? `Deleted managed skill "${model.name}".`
            : `Managed skill: ${model.name}`;
  return (
    <div data-t6-memory-card data-t6-tool="manage_skill">
      <ToolCard rawResult={JSON.stringify(model.raw)} state={state} summary={summary}>
        <div className="text-muted-foreground py-1 text-xs">
          {state.phase !== "error" && outcome.length > 0 && (
            <p className="text-foreground">{outcome}</p>
          )}
          {body !== undefined && body.length > 0 && (
            <div className="mt-1 text-sm">
              <MarkdownContent text={body} variant="compact" />
            </div>
          )}
          {model.malformed && <p className="mt-1">Some skill details were malformed.</p>}
        </div>
      </ToolCard>
    </div>
  );
}
