import type { AppClient } from "@omp-app/client";
import {
  TODO_DEFAULT_LIST,
  TODO_LIST_NAME_MAX,
  TODO_NOTES_MAX,
  TODO_TITLE_MAX,
  type TodoAuthor,
  TodoBoard,
  type TodoChange,
  type TodoItem,
  type TodoMirror,
  type TodoState,
  TodosPort,
} from "@omp-app/contracts";
import { cn } from "cn";
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Play, Square, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ChatTarget } from "../chat/controller";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";
import { usePhone } from "../phone";
import { problemWords } from "./problems";

const LATER = "The to-do list comes with the next server update.";

/** The list as this browser saw it last: shown at once, after a reload too, while it is read again. */
const kept = lastSeen<TodoBoard>("todos", (stored) => {
  const parsed = TodoBoard.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

/** The list and its newest changes, read again each time the server says the list changed. */
function useTodos(client: AppClient): {
  readonly board: TodoBoard | null;
  readonly changes: readonly TodoChange[];
  readonly problem: string | null;
} {
  const [board, setBoard] = useState<TodoBoard | null>(() => kept.get() ?? null);
  const [changes, setChanges] = useState<readonly TodoChange[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const todos = client.port(TodosPort);
    const read = (): void => {
      todos.list({}).then(
        (listed) => {
          if (!active) return;
          kept.set(listed);
          setBoard(listed);
          setProblem(null);
        },
        (failure: unknown) => active && setProblem(problemWords(failure, LATER, "read the list")),
      );
      todos.history({}).then(
        (history) => active && setChanges(history.changes),
        () => undefined,
      );
    };
    read();
    const stop = follow(client.subscribe(TodosPort, "changed"), read);
    return () => {
      active = false;
      stop();
    };
  }, [client]);
  return { board, changes, problem };
}

type Show = "open" | "done" | "all";

const SHOWS: readonly { readonly id: Show; readonly label: string }[] = [
  { id: "open", label: "To do" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

const shows = (show: Show, state: TodoState): boolean =>
  show === "all"
    ? true
    : show === "done"
      ? state === "done"
      : state === "open" || state === "doing";

/** A day as words: "today", "tomorrow", "yesterday", else "Mon 17 Nov". */
function dayWords(day: string, today: Date = new Date()): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const at = new Date(year, month - 1, date);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((at.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Whether a day is before today. */
function overdue(day: string, today: Date = new Date()): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return (
    new Date(year, month - 1, date) <
    new Date(today.getFullYear(), today.getMonth(), today.getDate())
  );
}

/** Who made a change, in words. */
export function authorWords(author: TodoAuthor): string {
  if (author.kind === "person") return "You";
  if (author.kind === "siyuan") return "A tick in SiYuan";
  return author.title ?? "A chat";
}

/** What a change did, in words: "marked done", "added", "moved to School". */
export function changeWords(change: TodoChange): string {
  const { before, after } = change;
  switch (change.action) {
    case "add":
      return "added";
    case "remove":
      return "removed";
    case "undo":
      return "took back a change to";
    case "move":
      return `moved to ${after?.list ?? "another list"}`;
    case "update":
      if (before !== null && after !== null && before.state !== after.state) {
        return after.state === "done"
          ? "marked done"
          : after.state === "doing"
            ? "started"
            : after.state === "dropped"
              ? "dropped"
              : "opened again";
      }
      if (before !== null && after !== null && before.title !== after.title) return "renamed";
      return "changed";
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The editor of one item: title, notes, list, due day and where it stands. */
function TodoEditor({
  item,
  lists,
  onSave,
  onCancel,
}: {
  readonly item: TodoItem;
  readonly lists: readonly string[];
  readonly onSave: (fields: {
    title: string;
    notes: string;
    list: string;
    due: string | null;
    state: TodoState;
  }) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes);
  const [list, setList] = useState(item.list);
  const [due, setDue] = useState(item.due ?? "");
  const [state, setState] = useState<TodoState>(item.state);
  const id = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (title.trim() === "") return;
    onSave({
      title: title.trim(),
      notes,
      list: list.trim() === "" ? TODO_DEFAULT_LIST : list.trim(),
      due: due === "" ? null : due,
      state,
    });
  };
  return (
    <form
      aria-label={`Edit ${item.title}`}
      onSubmit={submit}
      className="mb-2 ml-7 flex flex-col gap-2 rounded-md border border-l2 bg-l1 p-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-xs text-t3">
          Title
        </label>
        <Input
          id={`${id}-title`}
          value={title}
          maxLength={TODO_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          className="max-sm:h-11"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-notes`} className="text-xs text-t3">
          Notes
        </label>
        <Textarea
          id={`${id}-notes`}
          value={notes}
          maxLength={TODO_NOTES_MAX}
          rows={3}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-list`} className="text-xs text-t3">
            List
          </label>
          <Input
            id={`${id}-list`}
            value={list}
            list={`${id}-lists`}
            maxLength={TODO_LIST_NAME_MAX}
            onChange={(event) => setList(event.target.value)}
            className="max-sm:h-11"
          />
          <datalist id={`${id}-lists`}>
            {lists.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-due`} className="text-xs text-t3">
            Due
          </label>
          <Input
            id={`${id}-due`}
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="max-sm:h-11"
          />
        </div>
      </div>
      <ToggleGroup
        aria-label="Where it stands"
        size="sm"
        spacing={0.5}
        className="self-start rounded-lg border border-l2 p-0.5"
        value={[state]}
        onValueChange={(next: string[]) => {
          if (next[0] !== undefined) setState(next[0] as TodoState);
        }}
      >
        {(
          [
            ["open", "To do"],
            ["doing", "Doing"],
            ["done", "Done"],
            ["dropped", "Dropped"],
          ] as const
        ).map(([value, label]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="h-7 px-2 text-xs text-t3 aria-pressed:bg-l2 aria-pressed:text-t1 max-sm:h-11"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="max-sm:h-11" disabled={title.trim() === ""}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" className="max-sm:h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One item: its tick, its title, what stands beside it, and its buttons. */
function TodoRow({
  item,
  first,
  last,
  editing,
  lists,
  onChange,
  onMove,
  onRemove,
  onEdit,
  onOpenChat,
}: {
  readonly item: TodoItem;
  readonly first: boolean;
  readonly last: boolean;
  readonly editing: boolean;
  readonly lists: readonly string[];
  readonly onChange: (
    fields: Partial<Pick<TodoItem, "title" | "notes" | "list" | "due" | "state">>,
  ) => void;
  readonly onMove: (step: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onEdit: (editing: boolean) => void;
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const done = item.state === "done";
  const dropped = item.state === "dropped";
  const byChat = item.createdBy.kind === "chat" ? item.createdBy : null;
  const chat = item.chat;
  const phone = usePhone();
  const icon = "size-7 text-t3 hover:text-t1 tablet:size-11";
  const startWords = item.state === "doing" ? `Stop doing ${item.title}` : `Start ${item.title}`;
  const start = (): void => onChange({ state: item.state === "doing" ? "open" : "doing" });
  return (
    <li aria-label={item.title} className="group border-b border-l2 last:border-b-0">
      <div className="flex items-start gap-2 py-1.5">
        <Checkbox
          checked={done}
          aria-label={`Done: ${item.title}`}
          className="mt-0.5"
          onCheckedChange={(checked) => onChange({ state: checked ? "done" : "open" })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-sm break-words text-t1",
              (done || dropped) && "text-t3 line-through",
            )}
          >
            {item.title}
          </span>
          <span className="flex flex-wrap gap-x-2 text-xs text-t3">
            {item.state === "doing" && <span className="text-accent-ink">Doing</span>}
            {dropped && <span>Dropped</span>}
            {item.due !== null && (
              <span className={cn(!done && overdue(item.due) && "text-bad-ink")}>
                Due {dayWords(item.due)}
              </span>
            )}
            {item.notes !== "" && <span>Notes</span>}
            {byChat !== null && <span>Added by {byChat.title ?? "a chat"}</span>}
            {chat !== null && onOpenChat !== undefined && (
              <button
                type="button"
                className="text-accent-ink underline-offset-2 hover:underline max-sm:min-h-11"
                onClick={() =>
                  onOpenChat({
                    kind: "existing",
                    threadId: chat.threadId,
                    sessionFile: null,
                    ...(chat.folder === null ? {} : { folder: chat.folder }),
                  })
                }
              >
                Open {chat.title === null ? "its chat" : `“${chat.title}”`}
              </button>
            )}
          </span>
        </div>
        {phone ? (
          // A phone's row keeps its width for the title: its actions are one menu, a sheet from the foot.
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${item.title}`}
              className="grid size-11 shrink-0 place-items-center rounded-md text-t3 outline-none data-popup-open:bg-l2 data-popup-open:text-t1"
            >
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto">
              {!done && !dropped && (
                <DropdownMenuItem onClick={start}>
                  {item.state === "doing" ? <Square /> : <Play />}
                  {item.state === "doing" ? "Stop doing it" : "Start it"}
                </DropdownMenuItem>
              )}
              {!first && (
                <DropdownMenuItem onClick={() => onMove(-1)}>
                  <ArrowUp />
                  Move up
                </DropdownMenuItem>
              )}
              {!last && (
                <DropdownMenuItem onClick={() => onMove(1)}>
                  <ArrowDown />
                  Move down
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onEdit(!editing)}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2 />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {!done && !dropped && (
              <Button
                variant="ghost"
                size="icon-sm"
                className={icon}
                aria-label={startWords}
                onClick={start}
              >
                {item.state === "doing" ? <Square /> : <Play />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className={icon}
              aria-label={`Move up: ${item.title}`}
              disabled={first}
              onClick={() => onMove(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={icon}
              aria-label={`Move down: ${item.title}`}
              disabled={last}
              onClick={() => onMove(1)}
            >
              <ArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={icon}
              aria-label={`Edit ${item.title}`}
              aria-expanded={editing}
              onClick={() => onEdit(!editing)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={icon}
              aria-label={`Remove ${item.title}`}
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          </span>
        )}
      </div>
      {editing && (
        <TodoEditor
          item={item}
          lists={lists}
          onSave={(fields) => {
            onChange(fields);
            onEdit(false);
          }}
          onCancel={() => onEdit(false)}
        />
      )}
    </li>
  );
}

/**
 * The to-do list (D7): one list for you and your chats' agents, kept on the server, beside each chat's own todos. Add
 * to it, tick things off, start, edit, order and remove them; each change says who made it and can be taken back.
 */
export function TodoSection({
  client,
  onOpenChat,
}: {
  readonly client: AppClient;
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const { board, changes, problem } = useTodos(client);
  const [show, setShow] = useState<Show>("open");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [list, setList] = useState(TODO_DEFAULT_LIST);
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const id = useId();
  const todos = client.port(TodosPort);
  const attempt = useCallback((work: Promise<unknown>, action: string): void => {
    setFailed(null);
    work.catch((failure: unknown) => setFailed(problemWords(failure, LATER, action)));
  }, []);

  const items = board?.items ?? [];
  const lists = board?.lists ?? [TODO_DEFAULT_LIST];
  const needle = search.trim().toLowerCase();
  const matches = (item: TodoItem): boolean =>
    needle === "" ||
    item.title.toLowerCase().includes(needle) ||
    item.notes.toLowerCase().includes(needle) ||
    item.list.toLowerCase().includes(needle);
  const shown = items.filter((item) => shows(show, item.state) && matches(item));
  const openCount = items.filter((item) => item.state === "open" || item.state === "doing").length;
  const newest = changes[0];

  const add = (event: FormEvent): void => {
    event.preventDefault();
    const text = title.trim();
    if (text === "") return;
    const name = list.trim() === "" ? TODO_DEFAULT_LIST : list.trim();
    attempt(
      todos.add({ title: text, list: name }).then(() => setTitle("")),
      "add it",
    );
  };
  /** Moves an item one place up or down among the items its list shows now. */
  const move = (item: TodoItem, inList: readonly TodoItem[], step: -1 | 1): void => {
    const at = inList.indexOf(item);
    const neighbour = inList[at + step];
    if (neighbour === undefined) return;
    // Up: before the one above. Down: before the one after the one below, or last.
    const before = step === -1 ? neighbour.id : (inList[at + 2]?.id ?? null);
    attempt(todos.move({ id: item.id, before }), "move it");
  };

  return (
    <div className="flex flex-col gap-3">
      <form aria-label="Add a to-do" onSubmit={add} className="flex flex-wrap gap-2">
        <Input
          aria-label="New to-do"
          placeholder="Add a to-do"
          value={title}
          maxLength={TODO_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          className="min-w-48 flex-[3] max-sm:h-11"
        />
        <Input
          aria-label="To the list"
          value={list}
          list={`${id}-lists`}
          maxLength={TODO_LIST_NAME_MAX}
          onChange={(event) => setList(event.target.value)}
          className="w-36 min-w-28 flex-1 max-sm:h-11"
        />
        <datalist id={`${id}-lists`}>
          {lists.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Button type="submit" className="max-sm:h-11" disabled={title.trim() === ""}>
          Add
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Show"
          size="sm"
          spacing={0.5}
          className="rounded-lg border border-l2 p-0.5"
          value={[show]}
          onValueChange={(next: string[]) => {
            if (next[0] !== undefined) setShow(next[0] as Show);
          }}
        >
          {SHOWS.map((each) => (
            <ToggleGroupItem
              key={each.id}
              value={each.id}
              className="h-6 px-2 text-xs text-t3 aria-pressed:bg-l2 aria-pressed:text-t1 max-sm:h-11 tablet:h-11"
            >
              {each.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Input
          type="search"
          aria-label="Search the list"
          placeholder="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-7 w-40 flex-1 text-xs max-sm:h-11"
        />
        <span className="text-xs text-t3">{openCount} to do</span>
      </div>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      {failed !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {failed}
        </p>
      )}
      {board !== null && shown.length === 0 && (
        <p className="text-sm text-t3">
          {needle !== ""
            ? `Nothing in the list matches “${search.trim()}”.`
            : show === "done"
              ? "Nothing done yet."
              : "Nothing to do. Add what's next above; your chats can add to it too."}
        </p>
      )}
      {lists.map((name) => {
        const inList = shown.filter((item) => item.list === name);
        if (inList.length === 0) return null;
        return (
          <section key={name} aria-label={name} className="flex flex-col">
            <h4 className="text-xs font-medium text-t3">{name}</h4>
            <ul aria-label={`${name}: its items`} className="flex flex-col">
              {inList.map((item, index) => (
                <TodoRow
                  key={item.id}
                  item={item}
                  first={index === 0}
                  last={index === inList.length - 1}
                  editing={editing === item.id}
                  lists={lists}
                  onChange={(fields) =>
                    attempt(todos.update({ id: item.id, ...fields }), "change it")
                  }
                  onMove={(step) => move(item, inList, step)}
                  onRemove={() => attempt(todos.remove({ id: item.id }), "remove it")}
                  onEdit={(open) => setEditing(open ? item.id : null)}
                  {...(onOpenChat === undefined ? {} : { onOpenChat })}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {newest !== undefined && (
        <div className="flex flex-col gap-1 border-t border-l2 pt-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-t3">
            <span className="min-w-0">
              {authorWords(newest.author)} {changeWords(newest)} “{newest.title}” at{" "}
              {time.format(newest.at)}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="max-sm:h-11"
              onClick={() => attempt(todos.undo({ change: newest.id }), "take it back")}
            >
              Undo
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto max-sm:h-11"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {historyOpen ? "Hide the changes" : "All changes"}
            </Button>
          </div>
          {historyOpen && (
            <ol aria-label="Changes, newest first" className="flex flex-col">
              {changes.slice(0, 50).map((change) => (
                <li
                  key={change.id}
                  className="flex items-center gap-2 border-b border-l2 py-1 text-xs text-t2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    {authorWords(change.author)} {changeWords(change)} “{change.title}”
                  </span>
                  <span className="shrink-0 text-t3">{time.format(change.at)}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="max-sm:h-11"
                    aria-label={`Undo: ${authorWords(change.author)} ${changeWords(change)} “${change.title}”`}
                    onClick={() => attempt(todos.undo({ change: change.id }), "take it back")}
                  >
                    Undo
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <SiyuanCopy client={client} revision={board?.revision ?? 0} />
    </div>
  );
}

/** Where the copy is written, said shortly. */
function copyWords(mirror: TodoMirror): string {
  if (mirror.target === null) return "Off.";
  const last = mirror.lastWrite;
  if (last === null) return "Set; it is written after the next change.";
  return last.ok
    ? `Written at ${time.format(last.at)}.`
    : `The last write failed at ${time.format(last.at)}: ${last.problem ?? "no reason given"}.`;
}

/**
 * The list's copy in SiYuan (D7): one block at the end of a page, rewritten after each change, its ticks read back. The
 * API token is sent to the server once and never shown again.
 */
function SiyuanCopy({
  client,
  revision,
}: {
  readonly client: AppClient;
  readonly revision: number;
}): ReactNode {
  const todos = client.port(TodosPort);
  const [mirror, setMirror] = useState<TodoMirror | null>(null);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("http://127.0.0.1:6806");
  const [token, setToken] = useState("");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  // Read at first, and a moment after each change, when the copy has been written.
  useEffect(() => {
    let active = true;
    const read = (): void => {
      todos.mirror({}).then(
        (state) => {
          if (!active) return;
          setMirror(state);
          if (state.address !== null) setAddress(state.address);
          if (state.target !== null) setTarget(state.target);
        },
        () => undefined,
      );
    };
    const timer = setTimeout(read, revision === 0 ? 0 : 4_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [todos, revision]);
  if (mirror === null) return null;
  const save = (event: FormEvent): void => {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    todos
      .setMirror({
        address: address.trim(),
        target: target.trim(),
        ...(token.trim() === "" ? {} : { token: token.trim() }),
      })
      .then(
        (state) => {
          setMirror(state);
          setToken("");
          if (state.lastWrite?.ok === true) setOpen(false);
        },
        (failure: unknown) => setProblem(problemWords(failure, LATER, "set the copy")),
      )
      .finally(() => setSaving(false));
  };
  const turnOff = (): void => {
    setProblem(null);
    todos
      .setMirror({ off: true })
      .then(setMirror, (failure: unknown) =>
        setProblem(problemWords(failure, LATER, "turn the copy off")),
      );
  };
  return (
    <section aria-label="Copy in SiYuan" className="flex flex-col gap-2 border-t border-l2 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-t3">
        <span className="min-w-0 flex-1">
          <span className="text-t2">Copy in SiYuan:</span> {copyWords(mirror)}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="max-sm:h-11"
          aria-expanded={open}
          onClick={() => setOpen((now) => !now)}
        >
          {open ? "Close" : mirror.target === null ? "Set it up" : "Change"}
        </Button>
      </div>
      {open && (
        <form
          aria-label="The copy in SiYuan"
          onSubmit={save}
          className="flex flex-col gap-2 rounded-md border border-l2 bg-l1 p-2 text-xs text-t3"
        >
          <p>
            The list is copied to the end of a SiYuan page as one block, rewritten after each
            change; ticks made there count here. The API token is in SiYuan's Settings, under About;
            it stays on this server.
          </p>
          <label htmlFor={`${id}-address`}>SiYuan's address</label>
          <Input
            id={`${id}-address`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="max-sm:h-11"
          />
          <label htmlFor={`${id}-token`}>API token</label>
          <Input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            placeholder={mirror.tokenSaved ? "Saved; type a new one to change it" : ""}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="max-sm:h-11"
          />
          <label htmlFor={`${id}-target`}>The page's id (its block id, as Copy ID gives it)</label>
          <Input
            id={`${id}-target`}
            placeholder="20240101120000-abcdefg"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="max-sm:h-11"
          />
          {problem !== null && (
            <p role="alert" className="text-bad-ink">
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              className="max-sm:h-11"
              disabled={
                saving ||
                target.trim() === "" ||
                address.trim() === "" ||
                (!mirror.tokenSaved && token.trim() === "")
              }
            >
              {saving ? "Writing…" : "Save and write it"}
            </Button>
            {mirror.target !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="max-sm:h-11"
                onClick={turnOff}
              >
                Turn it off
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
