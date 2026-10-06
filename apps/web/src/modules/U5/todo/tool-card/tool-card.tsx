import { ThreadId } from "@omp-app/contracts";
import { ToolCard } from "@/modules/U3/tool-card/card";
import type {
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRendererProps,
} from "@/modules/U3/tool-card/contract";
import { normalizeToolRendererProps } from "@/modules/U3/tool-card/normalize";
import { TodoChecklist } from "../checklist";
import type { TodoPhase, TodoSnapshot } from "../contract";
import { TodoPhaseSchema } from "../contract";
import { projectTodoSnapshot } from "../model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function phasesFromResult(value: unknown): readonly TodoPhase[] | null {
  if (!isRecord(value)) return null;
  const details = isRecord(value.details) ? value.details : value;
  const parsed = TodoPhaseSchema.array().safeParse(details.phases);
  return parsed.success ? parsed.data : null;
}

function stateResult(state: ToolCardState, props: ToolRendererProps): unknown {
  return state.result ?? state.partialResult ?? props.result;
}

function toolModel(state: ToolCardState, props: ToolRendererProps) {
  const phases = phasesFromResult(stateResult(state, props));
  if (phases === null) return null;
  const snapshot: TodoSnapshot = {
    threadId: ThreadId.parse(`todo-tool-${state.toolCallId}`),
    phases: [...phases],
    source: "tool",
    sequence: 0,
    updatedAt: "1970-01-01T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  return projectTodoSnapshot(snapshot);
}

function summaryFor(model: ReturnType<typeof toolModel>, state: ToolCardState): string {
  if (model === null) {
    if (state.phase === "running" || state.phase === "partial") return "Updating todos";
    return "No todo phases returned";
  }
  return `Updated todos: ${model.progress.done} of ${model.progress.total} done`;
}

/** Renders omp's `todo` tool through U3's normalized, non-executing card grammar. */
export function TodoToolRenderer(props: ToolRendererProps) {
  const state = normalizeToolRendererProps(props);
  const model = toolModel(state, props);
  return (
    <div data-testid={`todo-tool-card-${state.toolCallId}`} data-tool-name="todo">
      <ToolCard state={state} summary={summaryFor(model, state)} />
      {model !== null && (
        <div
          className="border-border/70 ms-2 mt-1 border-s-2 ps-4"
          data-testid="todo-tool-checklist"
        >
          <TodoChecklist model={model} />
        </div>
      )}
    </div>
  );
}

/** Local U5 descriptor; the main agent composes it into U3's central registry. */
export const todoToolDescriptor = {
  id: "U5.todoTool",
  owner: "U5",
  title: "Todo",
  covers: ["E3.todo-tool-renderer"],
  requires: [],
  kind: "tool",
  match: { by: "name", name: "todo" },
  renderer: TodoToolRenderer,
} satisfies ToolRegistryDescriptor;
