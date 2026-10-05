import { Button } from "@/components/ui/button";
import { Icons } from "@/tokens";
import type { TodoReminderNoticeProps } from "./reminder";

export function TodoReminderNotice({
  snapshot,
  onViewPrevious,
  onDismissCleared,
}: TodoReminderNoticeProps) {
  if (snapshot.cleared) {
    return (
      <aside
        aria-live="polite"
        className="border-warning/30 bg-warning-surface text-warning-surface-foreground rounded-lg border p-3 text-sm"
        data-testid="todo-cleared-notice"
        role="status"
      >
        <div className="flex items-start gap-2">
          <Icons.info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Todos cleared</p>
            <p className="mt-1 text-xs">The previous list is retained briefly for review.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {onViewPrevious && (
                <Button size="xs" type="button" variant="outline" onClick={onViewPrevious}>
                  View previous todos
                </Button>
              )}
              {onDismissCleared && (
                <Button size="xs" type="button" variant="ghost" onClick={onDismissCleared}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        </div>
      </aside>
    );
  }
  if (snapshot.reminder === null) return null;
  const count = snapshot.reminder.todos.length;
  return (
    <aside
      aria-live="polite"
      className="border-warning/30 bg-warning-surface text-warning-surface-foreground rounded-lg border p-3 text-sm"
      data-testid="todo-reminder-notice"
      role="status"
    >
      <div className="flex items-start gap-2">
        <Icons.warning aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {count} incomplete {count === 1 ? "todo" : "todos"} — reminder{" "}
            {snapshot.reminder.attempt}/{snapshot.reminder.maxAttempts}
          </p>
          <ul className="mt-2 list-disc space-y-1 ps-4 text-xs">
            {snapshot.reminder.todos.map((task) => (
              <li key={`${task.content}-${task.status}`}>{task.content}</li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}

export interface TodoReminderBadgeProps {
  readonly count: number;
  readonly label?: string;
}

export function TodoReminderBadge({ count, label = "Todo reminders" }: TodoReminderBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${label}: ${count}`}
      className="bg-warning text-warning-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[0.7rem] font-semibold leading-none"
      data-testid="todo-reminder-badge"
      role="status"
      title={`${count} todo reminder${count === 1 ? "" : "s"}`}
    >
      {count}
    </span>
  );
}
