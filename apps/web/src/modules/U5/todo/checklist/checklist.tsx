import { cn } from "cn";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Icons } from "@/tokens";
import type { TodoModel, TodoPhaseModel, TodoTaskModel } from "../model";

export interface TodoTaskStatusPresentation {
  readonly label: string;
  readonly icon?: typeof Icons.check;
  readonly glyph?: "pending";
  readonly className: string;
}

export const TODO_TASK_STATUS_PRESENTATION: Record<
  TodoTaskModel["status"],
  TodoTaskStatusPresentation
> = {
  pending: { label: "Pending", glyph: "pending", className: "text-muted-foreground" },
  in_progress: { label: "In progress", icon: Icons.loading, className: "text-info" },
  completed: { label: "Done", icon: Icons.check, className: "text-success" },
  abandoned: { label: "Cancelled", icon: Icons.close, className: "text-muted-foreground" },
  blocked: { label: "Blocked", icon: Icons.warning, className: "text-warning" },
};

export interface TodoTaskStatusIconProps {
  readonly status: TodoTaskModel["status"];
  readonly className?: string;
  readonly testId?: string;
}

export function TodoTaskStatusIcon({ status, className, testId }: TodoTaskStatusIconProps) {
  const presentation = TODO_TASK_STATUS_PRESENTATION[status];
  const Icon = presentation.icon;
  const iconClassName = cn(
    "mt-0.5 size-4 shrink-0",
    presentation.className,
    status === "in_progress" && "animate-spin motion-reduce:animate-none",
    className,
  );
  if (presentation.glyph === "pending") {
    return (
      <span
        aria-hidden="true"
        className={cn("rounded-full border-2 border-current", iconClassName)}
        data-testid={testId}
      />
    );
  }
  return Icon ? <Icon aria-hidden="true" className={iconClassName} data-testid={testId} /> : null;
}

export interface TodoChecklistProps {
  readonly model: TodoModel;
  readonly className?: string;
}

function isFinished(phase: TodoPhaseModel): boolean {
  return phase.progress.total > 0 && phase.progress.done === phase.progress.total;
}

function phaseContentId(phase: TodoPhaseModel): string {
  return `todo-phase-content-${phase.id}`;
}

export function TodoChecklist({ model, className }: TodoChecklistProps) {
  return (
    <section
      className={cn("min-w-0", className)}
      data-testid="todo-checklist"
      data-todo-progress={`${model.progress.done} of ${model.progress.total} done`}
    >
      <p className="text-muted-foreground mb-3 text-xs" data-testid="todo-progress">
        {model.progress.done} of {model.progress.total} done
      </p>
      {model.phases.length === 0 ? (
        <p
          className="text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-sm"
          data-testid="todo-empty"
        >
          No todos yet.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="todo-phase-list">
          {model.phases.map((phase) => (
            <li key={phase.id}>
              <TodoPhaseSection currentTaskId={model.currentTask?.id} phase={phase} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TodoPhaseSection({
  currentTaskId,
  phase,
}: {
  readonly currentTaskId: string | undefined;
  readonly phase: TodoPhaseModel;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const open = manualOpen ?? !isFinished(phase);
  const contentId = phaseContentId(phase);
  return (
    <Collapsible
      className="border-border/80 bg-card/60 rounded-lg border"
      data-phase-id={phase.id}
      data-phase-finished={isFinished(phase) ? "true" : "false"}
      data-testid={`todo-phase-${phase.id}`}
      open={open}
      onOpenChange={setManualOpen}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <CollapsibleTrigger
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${phase.name}`}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded-md text-start outline-none focus-visible:ring-3"
          data-testid={`todo-phase-toggle-${phase.id}`}
        >
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{phase.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {phase.progress.done} of {phase.progress.total} done
            </span>
          </span>
        </CollapsibleTrigger>
        <span aria-hidden="true" className="text-muted-foreground">
          {open ? <Icons.chevronUp className="size-4" /> : <Icons.chevronDown className="size-4" />}
        </span>
      </div>
      <CollapsibleContent id={contentId}>
        <ul className="border-border/70 space-y-1 border-t px-2 py-2">
          {phase.tasks.map((task) => (
            <TodoTaskRow current={task.id === currentTaskId} key={task.id} task={task} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TodoTaskRow({
  current,
  task,
}: {
  readonly current: boolean;
  readonly task: TodoTaskModel;
}) {
  const presentation = TODO_TASK_STATUS_PRESENTATION[task.status];
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn(
        "min-w-0 rounded-md px-2 py-2 text-sm",
        current && "bg-info-surface/70 ring-1 ring-info/40",
      )}
      data-current={current ? "true" : "false"}
      data-status={task.status}
      data-task-id={task.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        <TodoTaskStatusIcon status={task.status} testId={`todo-status-${task.id}`} />
        <div className="min-w-0 flex-1">
          <p className="break-words text-foreground">{task.content}</p>
          <span className="sr-only">{presentation.label}</span>
          {task.blocker && <p className="mt-1 text-xs text-warning">Blocked by: {task.blocker}</p>}
          {task.details && <p className="mt-1 text-xs text-muted-foreground">{task.details}</p>}
          {task.notes && task.notes.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
              {task.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
