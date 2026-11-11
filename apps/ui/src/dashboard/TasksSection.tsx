import type { AppClient } from "@omp-app/client";
import {
  type QueuedTask,
  type RunningChat,
  TASK_TEXT_MAX,
  TaskListResult,
  TasksPort,
  type TaskTarget,
  type TaskWhen,
} from "@omp-app/contracts";
import { ArrowDown, ArrowUp, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ChatTarget } from "../chat/controller";
import { fromLocalInput, localInput } from "../chat/taskTime";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";
import { problemWords } from "./problems";

const LATER = "Tasks come with the next server update.";

/** The list as this browser saw it last: shown at once, after a reload too, while it is read again. */
const kept = lastSeen<TaskListResult>("tasks", (stored) => {
  const parsed = TaskListResult.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

/** The queue, read again each time the server says it changed. */
function useTasks(client: AppClient): {
  readonly tasks: readonly QueuedTask[] | null;
  readonly problem: string | null;
} {
  const [tasks, setTasks] = useState<readonly QueuedTask[] | null>(() => kept.get()?.tasks ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(TasksPort)
        .list({})
        .then(
          (listed) => {
            if (!active) return;
            kept.set(listed);
            setTasks(listed.tasks);
            setProblem(null);
          },
          (failure: unknown) =>
            active && setProblem(problemWords(failure, LATER, "read the tasks")),
        );
    };
    read();
    const stop = follow(client.subscribe(TasksPort, "changed"), read);
    return () => {
      active = false;
      stop();
    };
  }, [client]);
  return { tasks, problem };
}

const clock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const folderName = (folder: string): string =>
  folder
    .split("/")
    .filter((part) => part !== "")
    .at(-1) ?? folder;

/** When a waiting task goes, in words: "As soon as its chat is free", "After its window resets, at Wed 14:05". */
export function whenWords(task: Pick<QueuedTask, "when" | "after">): string {
  switch (task.when.kind) {
    case "free":
      return "As soon as its chat is free";
    case "reset":
      return task.after === null
        ? "After its window resets"
        : `After its window resets, at ${clock.format(task.after)}`;
    case "at":
      return `At ${clock.format(task.when.at)}`;
  }
}

/** A task's chat in words: its name when queued, else as the running chats list has it, or a new chat's folder. */
function targetWords(task: QueuedTask, running: readonly RunningChat[]): string {
  if (task.target.kind === "new") return `A new chat in ${folderName(task.target.folder)}`;
  const { threadId } = task.target;
  return (
    task.label ??
    running.find((chat) => chat.threadId === threadId)?.title ??
    `A chat (${threadId.slice(0, 8)})`
  );
}

interface TargetChoice {
  readonly value: string;
  readonly label: string;
  readonly target: TaskTarget;
  /** The name the task keeps for its chat. */
  readonly name: string;
}

/** The chats a task can go to: each running chat, then a new chat in each of their folders. */
function targetChoices(running: readonly RunningChat[]): readonly TargetChoice[] {
  const chats = running.map((chat) => ({
    value: `chat:${chat.threadId}`,
    label: chat.title ?? "New chat",
    target: { kind: "chat", threadId: chat.threadId } as const,
    name: chat.title ?? "New chat",
  }));
  const folders = [...new Set(running.map((chat) => chat.folder))].map((folder) => ({
    value: `new:${folder}`,
    label: `A new chat in ${folderName(folder)}`,
    target: { kind: "new", folder } as const,
    name: folderName(folder),
  }));
  return [...chats, ...folders];
}

/** The form of a new task (its chat picked here) or of a waiting one (its message and when it goes). */
function TaskForm({
  running,
  task,
  onSave,
  onCancel,
}: {
  readonly running: readonly RunningChat[];
  readonly task?: QueuedTask;
  readonly onSave: (args: {
    readonly text: string;
    readonly target: TaskTarget;
    readonly name: string | null;
    readonly when: TaskWhen;
  }) => Promise<void>;
  readonly onCancel: () => void;
}): ReactNode {
  const textId = useId();
  const choices = targetChoices(running);
  const [text, setText] = useState(task?.text ?? "");
  const [picked, setPicked] = useState(choices[0]?.value ?? "");
  const [when, setWhen] = useState<TaskWhen["kind"]>(task?.when.kind ?? "free");
  const [at, setAt] = useState(() =>
    localInput(task?.when.kind === "at" ? task.when.at : Date.now() + 60 * 60_000),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const choice = choices.find((each) => each.value === picked);
  const target = task?.target ?? choice?.target;
  const newChat = target?.kind === "new";

  const save = async (): Promise<void> => {
    if (text.trim() === "") {
      setProblem("Write the message first.");
      return;
    }
    if (target === undefined) {
      setProblem("Open a chat first: a task goes to a running chat, or a new chat in its folder.");
      return;
    }
    let goes: TaskWhen;
    if (when === "at") {
      const ms = fromLocalInput(at);
      if (ms === null) {
        setProblem("Pick the time it goes.");
        return;
      }
      goes = { kind: "at", at: ms };
    } else {
      goes = { kind: newChat && when === "reset" ? "free" : when };
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave({
        text: text.trim(),
        target,
        name: task?.label ?? choice?.name ?? null,
        when: goes,
      });
    } catch (failure) {
      setProblem(problemWords(failure, LATER, "queue the task"));
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={task === undefined ? "New task" : "Edit task"}
      className="flex flex-col gap-3 rounded-lg border border-l2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={textId} className="text-xs text-t3">
          Message
        </label>
        <Textarea
          id={textId}
          value={text}
          rows={3}
          maxLength={TASK_TEXT_MAX}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {task === undefined && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 text-[0.8125rem] text-t1">
          For
          {choices.length === 0 ? (
            <span className="text-t3">no running chat: open one first</span>
          ) : (
            <Select
              items={choices.map(({ value, label }) => ({ value, label }))}
              value={picked}
              onValueChange={(next) => {
                if (typeof next === "string") setPicked(next);
              }}
            >
              <SelectTrigger
                aria-label="Chat"
                size="sm"
                className="max-w-full min-w-48 justify-between dark:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((each) => (
                  <SelectItem key={each.value} value={each.value}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-t3">It goes</legend>
        <RadioGroup
          aria-label="It goes"
          className="gap-0"
          value={newChat && when === "reset" ? "free" : when}
          onValueChange={(next) => {
            if (next === "free" || next === "reset" || next === "at") setWhen(next);
          }}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className="flex min-h-11 items-center gap-2 text-[0.8125rem] text-t1">
            <RadioGroupItem value="free" aria-label="As soon as the chat is free" />
            As soon as the chat is free
          </label>
          {!newChat && (
            // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
            <label className="flex min-h-11 items-center gap-2 text-[0.8125rem] text-t1">
              <RadioGroupItem
                value="reset"
                aria-label="After its provider's 5-hour window resets"
              />
              After its provider's 5-hour window resets
            </label>
          )}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className="flex min-h-11 items-center gap-2 text-[0.8125rem] text-t1">
            <RadioGroupItem value="at" aria-label="At a time" />
            At a time
          </label>
        </RadioGroup>
        {when === "at" && (
          <Input
            aria-label="Time"
            type="datetime-local"
            className="w-56 dark:bg-transparent"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        )}
        <p className="text-xs text-t3">
          A task goes only while its chat is free: no turn running, not paused, not held by a usage
          rule. A chat's tasks go one at a time, in the order of this list.
        </p>
      </fieldset>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {task === undefined ? "Queue it" : "Save task"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The tasks (#14): messages for chats, kept by the server and sent in this order as each chat is free, after its
 * provider's window resets, or at a time; each waiting one can move, go now, change or go; the done ones fold below.
 */
export function TasksSection({
  client,
  running,
  onOpenChat,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const { tasks, problem } = useTasks(client);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const port = client.port(TasksPort);
  const act = (work: Promise<unknown>): void => {
    setFailure(null);
    work.catch((caught: unknown) => setFailure(problemWords(caught, LATER, "change the task")));
  };
  if (problem !== null && tasks === null)
    return <p className="text-[0.8125rem] text-t3">{problem}</p>;
  if (tasks === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  const waiting = tasks.filter((task) => task.state === "waiting");
  const done = tasks.filter((task) => task.state !== "waiting");

  return (
    <div className="flex flex-col gap-2">
      {waiting.length === 0 && !adding && (
        <p className="text-[0.8125rem] text-t3">
          No task waits. A task is a message for a chat, sent as soon as the chat is free, after its
          window resets, or at a time.
        </p>
      )}
      {waiting.length > 0 && (
        <ol aria-label="Waiting tasks" className="flex flex-col gap-2">
          {waiting.map((task, index) =>
            editing === task.id ? (
              <li key={task.id}>
                <TaskForm
                  running={running}
                  task={task}
                  onCancel={() => setEditing(null)}
                  onSave={async ({ text, when }) => {
                    await port.update({ id: task.id, text, when });
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li
                key={task.id}
                className="flex flex-col gap-1 rounded-lg border border-l2 px-3 py-2"
              >
                <p className="line-clamp-2 text-[0.8125rem] whitespace-pre-wrap text-t1">
                  {task.text}
                </p>
                <p className="text-xs text-t3">
                  {targetWords(task, running)} · {whenWords(task)}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() =>
                      act(port.move({ id: task.id, before: waiting[index - 1]?.id ?? null }))
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={index === waiting.length - 1}
                    onClick={() =>
                      act(port.move({ id: task.id, before: waiting[index + 2]?.id ?? null }))
                    }
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={task.when.kind === "free"}
                    onClick={() => act(port.sendNow({ id: task.id }))}
                  >
                    <Send />
                    Send now
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit task"
                    onClick={() => setEditing(task.id)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove task"
                    onClick={() => act(port.remove({ id: task.id }))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      {adding ? (
        <TaskForm
          running={running}
          onCancel={() => setAdding(false)}
          onSave={async ({ text, target, name, when }) => {
            await port.add({ text, target, when, ...(name === null ? {} : { label: name }) });
            setAdding(false);
          }}
        />
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setAdding(true)}>
          <Plus />
          New task
        </Button>
      )}
      {failure !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {failure}
        </p>
      )}
      {done.length > 0 && (
        <details className="group">
          <summary className="min-h-11 cursor-pointer content-center text-xs text-t3">
            Sent and failed ({done.length})
          </summary>
          <ol aria-label="Done tasks" className="flex flex-col">
            {done.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-2 border-b border-l2 py-1.5 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.8125rem] text-t1">{task.text}</span>
                  <span
                    className={`text-xs ${task.state === "failed" ? "text-bad-ink" : "text-t3"}`}
                  >
                    {task.state === "failed"
                      ? `Not sent: ${task.problem ?? "the chat could not take it"}`
                      : `Sent to ${targetWords(task, running)}${task.sentAt === null ? "" : ` · ${clock.format(task.sentAt)}`}`}
                  </span>
                </div>
                {task.state === "sent" && task.sentTo !== null && onOpenChat !== undefined && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="max-sm:h-11"
                    onClick={() => {
                      if (task.sentTo === null) return;
                      onOpenChat({
                        kind: "existing",
                        threadId: task.sentTo,
                        sessionFile: null,
                        ...(task.target.kind === "new" ? { folder: task.target.folder } : {}),
                      });
                    }}
                  >
                    Open chat
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove task"
                  onClick={() => act(port.remove({ id: task.id }))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
