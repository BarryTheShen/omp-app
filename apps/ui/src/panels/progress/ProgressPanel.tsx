import { type ReactNode, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../../chat/controller";
import { GoalDetails } from "../../goal/GoalDetails";
import { KEYS, keycap } from "../../keys/table";
import { currentTask, finished, TodoList } from "../../todos/TodoList";

function Section({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  // A heading, not a region: the goal and the todo list inside are named regions of their own ("Goal", "Todos").
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3">
      <h3 className="flex items-baseline gap-2 text-xs font-medium text-t3">
        {title}
        {aside}
      </h3>
      {children}
    </div>
  );
}

/**
 * The focused chat's progress: its goal (with Pause, Resume and Drop, or Set a goal), omp's todo list phase by phase, and
 * plan mode. It shows what the chips in the message box show, all at once.
 */
export function ProgressPanel({
  chat,
  openGoal,
}: {
  readonly chat: ChatController | null;
  readonly openGoal: (chat: ChatController) => void;
}): ReactNode {
  if (chat === null) {
    return <p className="px-4 py-3 text-[0.8125rem] text-t3">Open a chat to see its progress.</p>;
  }
  return <ChatProgress key={chat.threadId ?? "new"} chat={chat} openGoal={openGoal} />;
}

function ChatProgress({
  chat,
  openGoal,
}: {
  readonly chat: ChatController;
  readonly openGoal: (chat: ChatController) => void;
}): ReactNode {
  const goal = useSyncExternalStore(chat.store.subscribe, () => chat.store.getSnapshot().goal);
  const todos = useSyncExternalStore(chat.store.subscribe, () => chat.store.getSnapshot().todos);
  const plan = useSyncExternalStore(chat.store.subscribe, () => chat.store.getSnapshot().planMode);
  const tasks = todos.flatMap((phase) => phase.tasks);
  const done = tasks.filter(finished).length;
  const now = currentTask(todos);
  const showGoal = goal !== null && goal.status !== "dropped";
  return (
    <div className="flex flex-col divide-y divide-l2">
      <Section title="Goal">
        {showGoal ? (
          <GoalDetails controller={chat} goal={goal} />
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[0.8125rem] text-t3">No goal in this chat.</p>
            <Button type="button" size="sm" variant="outline" onClick={() => openGoal(chat)}>
              Set a goal…
            </Button>
          </div>
        )}
      </Section>
      <Section
        title="Todos"
        aside={
          tasks.length > 0 && (
            <span className="tabular-nums">
              {done}/{tasks.length} done
            </span>
          )
        }
      >
        {tasks.length === 0 ? (
          <p className="text-[0.8125rem] text-t3">omp keeps no todo list in this chat.</p>
        ) : (
          <>
            {now !== null && (
              <p className="text-[0.8125rem] text-t2">
                Now: <span className="text-t1">{now.content}</span>
              </p>
            )}
            <TodoList phases={todos} />
          </>
        )}
      </Section>
      {plan?.available === true && (
        <Section title="Plan mode">
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[0.8125rem] text-t2">
              {plan.enabled
                ? "On: omp plans and changes nothing until you approve."
                : "Off: omp works on the chat directly."}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={plan.enabled}
              aria-keyshortcuts="Alt+Shift+P"
              title={keycap(KEYS.planMode)}
              onClick={() => {
                chat
                  .setPlanMode(!plan.enabled)
                  .catch((failure: unknown) =>
                    chat.store.addNotice(
                      `Plan mode: ${failure instanceof Error ? failure.message : String(failure)}`,
                      "error",
                    ),
                  );
              }}
            >
              {plan.enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}
