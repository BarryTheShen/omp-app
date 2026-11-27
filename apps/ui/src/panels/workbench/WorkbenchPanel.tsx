import type { AppClient } from "@omp-app/client";
import {
  type ThreadId,
  type WorkThreadAnswer,
  type WorkThreadEntry,
  type WorkThreadId,
  type WorkThreadKind,
  type WorkThreadLink,
  type WorkThreadQuestion,
  type WorkThreadState,
  type WorkThreadSummary,
  WorkThreadsPort,
} from "@omp-app/contracts";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { ArrowLeft, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ChatController, ChatTarget } from "../../chat/controller";
import { OmpQuestionCard } from "../../chat/HostRequests";
import { isImeEnter } from "../../keys/ime";
import { PlanCard } from "../../plan/PlanCard";
import { useOmpQuestions, usePlan } from "../../questions/waiting";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";
import { TabButton } from "../btw/BtwPanel";
import { type Draft, decided, draftOf, QuestionFields } from "../btw/QuestionCard";
import {
  FILTERS,
  type Filter,
  filtered,
  tabName,
  useWorkThread,
  useWorkThreadList,
} from "./threads";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const WHEN = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const KINDS: readonly { readonly kind: WorkThreadKind; readonly label: string }[] = [
  { kind: "bug", label: "Bug" },
  { kind: "feature", label: "Feature" },
  { kind: "task", label: "Task" },
  { kind: "question", label: "Question" },
];

const STATE_LABELS: Record<WorkThreadState, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting on you",
  done: "Done",
  closed: "Closed",
};

const kindLabel = (kind: WorkThreadKind): string =>
  kind === "briefing" ? "Briefing" : (KINDS.find((one) => one.kind === kind)?.label ?? kind);

/** Ctrl+Enter (⌘+Enter on a Mac) runs `act`, as the message box sends. */
const onCtrlEnter =
  (act: () => void) =>
  (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || isImeEnter(event)) return;
    event.preventDefault();
    act();
  };

type View =
  | { readonly kind: "list" }
  | { readonly kind: "thread"; readonly id: WorkThreadId }
  | { readonly kind: "new" };

/**
 * A chat's Workbench (threads, one per piece of work, like a repository's issues): the threads of the chat you are in,
 * in two tabs as a repository's issues have (Open, what waits on you first; Closed), each with its kind, its label (In
 * progress, Waiting on you, Done), bar and what waits on you; a thread's timeline, with its questions to answer and a
 * box to write in; and New thread, which opens one for this
 * chat. Another chat focused shows its own list.
 */
export function WorkbenchPanel({
  client,
  chat,
  openChat,
}: {
  readonly client: AppClient;
  readonly chat: ChatController | null;
  readonly openChat?: (target: ChatTarget) => void;
}): ReactNode {
  const { list, missing } = useWorkThreadList(client);
  const [view, setView] = useState<View>({ kind: "list" });
  const [filter, setFilter] = useState<Filter>("Open");
  // What stops this chat until you answer (omp's questions, a plan to approve): at the top of its Workbench.
  const plan = usePlan(chat);
  const omp = useOmpQuestions(chat);
  const stops = omp.length + (plan === null ? 0 : 1);
  /** The chat you are in, once omp gave it its id: the Workbench is its. */
  const here = chat?.threadId ?? null;
  // Another chat focused: its own Workbench, from its list (React's way of resetting state for a new prop).
  const [shownFor, setShownFor] = useState(here);
  if (shownFor !== here) {
    setShownFor(here);
    setView({ kind: "list" });
  }
  if (missing)
    return <p className="px-3 py-2 text-sm text-t3">This server has no Workbench yet.</p>;
  if (here === null)
    return (
      <p className="px-3 py-2 text-sm text-t3">
        Open a chat to see its Workbench: its threads, one per plan, feature or bug.
      </p>
    );
  if (list === null) return <p className="px-3 py-2 text-sm text-t3">Reading the threads…</p>;
  if (view.kind === "thread")
    return (
      <ThreadView
        client={client}
        id={view.id}
        chat={chat}
        openChat={openChat}
        onBack={() => setView({ kind: "list" })}
      />
    );
  if (view.kind === "new")
    return (
      <NewThread
        client={client}
        here={here}
        onOpened={(id) => setView({ kind: "thread", id })}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  const threads = list.threads.filter((thread) => thread.owner === here);
  const shown = filtered(threads, filter);
  const stopsShown = filter === "Open" && chat !== null;
  return (
    <div data-tour="workbench-panel" className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Threads"
        className="row-scroll flex shrink-0 gap-1 px-2 pt-1.5"
      >
        {FILTERS.map((name) => (
          <TabButton key={name} selected={filter === name} onClick={() => setFilter(name)}>
            {tabName(name, threads)}
          </TabButton>
        ))}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-2">
        <Button size="sm" onClick={() => setView({ kind: "new" })}>
          <Plus />
          New thread
        </Button>
      </div>
      {stopsShown && <ChatStops controller={chat} />}
      {shown.length === 0 && (!stopsShown || stops === 0) ? (
        <p className="px-3 py-2 text-sm text-t3">
          {filter === "Open" ? "No open threads." : "No closed threads."}
        </p>
      ) : (
        <ul
          aria-label="Thread list"
          className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2"
        >
          {shown.map((thread) => (
            <li key={thread.id}>
              <ThreadRow
                thread={thread}
                onOpen={() => setView({ kind: "thread", id: thread.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What stops the chat until you answer, as above its message box and answered in either place: the plan omp proposed in
 * plan mode, and omp's own questions. Nothing when nothing stops it.
 */
function ChatStops({ controller }: { readonly controller: ChatController }): ReactNode {
  const plan = usePlan(controller);
  const omp = useOmpQuestions(controller);
  if (plan === null && omp.length === 0) return null;
  return (
    <section
      aria-label="The chat waits for you"
      className="flex shrink-0 flex-col gap-1.5 px-2 pb-2"
    >
      <h3 className="px-1 text-xs font-medium text-warn-ink">The chat waits for you</h3>
      {plan !== null && <PlanCard controller={controller} proposal={plan} inPanel />}
      {omp.map((request) => (
        <OmpQuestionCard
          key={request.id}
          request={request}
          answerWith={(answer) => controller.answer(request.id, answer)}
        />
      ))}
    </section>
  );
}

/** A thread's bar: how many of its steps are done. */
function ProgressBar({ thread }: { readonly thread: WorkThreadSummary }): ReactNode {
  const progress = thread.progress;
  if (progress === null) return null;
  return (
    <span
      role="progressbar"
      aria-label={`${progress.done} of ${progress.total} steps`}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      className="block h-1 w-full overflow-hidden rounded-full bg-l2"
    >
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${(100 * progress.done) / progress.total}%` }}
      />
    </span>
  );
}

export function ThreadRow({
  thread,
  onOpen,
}: {
  readonly thread: WorkThreadSummary;
  readonly onOpen: () => void;
}): ReactNode {
  const waits =
    thread.unanswered > 0
      ? `, ${thread.unanswered} question${thread.unanswered === 1 ? "" : "s"} for you`
      : "";
  return (
    <button
      type="button"
      aria-label={`${thread.title}, ${STATE_LABELS[thread.state]}${waits}`}
      onClick={onOpen}
      className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring max-sm:py-2.5"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-t1">{thread.title}</span>
        {thread.unanswered > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-xs text-accent-foreground">
            {thread.unanswered}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2 text-xs text-t3">
        <span>{kindLabel(thread.kind)}</span>
        {thread.state === "open" ? null : (
          <span
            className={`rounded-full border px-1.5 ${thread.state === "waiting" ? "border-warn-ink text-warn-ink" : "border-l2"}`}
          >
            {STATE_LABELS[thread.state]}
          </span>
        )}
        {thread.progress !== null && (
          <span>
            · {thread.progress.done}/{thread.progress.total}
          </span>
        )}
      </span>
      <ProgressBar thread={thread} />
      {thread.last !== null && (
        <span className="line-clamp-1 text-xs text-t3">{thread.last.text}</span>
      )}
    </button>
  );
}

/** Who wrote an entry, as the person reads it. */
function whoOf(entry: WorkThreadEntry): string {
  if (entry.by.kind === "person") return "You";
  if (entry.by.kind === "app") return "The app";
  return entry.by.title ?? "A chat";
}

/** A link as a line: a page opens in a new tab; a commit, a release and a chat are named. */
function LinkLine({
  link,
  openChat,
}: {
  readonly link: WorkThreadLink;
  readonly openChat?: (target: ChatTarget) => void;
}): ReactNode {
  switch (link.kind) {
    case "issue":
    case "url":
      return (
        <a href={link.url} target="_blank" rel="noreferrer" className="text-accent-ink underline">
          {link.title ?? link.url}
        </a>
      );
    case "commit":
      return <span className="font-mono">{link.sha.slice(0, 9)}</span>;
    case "release":
      return <span>Release {link.version}</span>;
    case "chat":
      return openChat === undefined ? (
        <span>{link.title ?? "A chat"}</span>
      ) : (
        <button
          type="button"
          className="text-accent-ink underline"
          onClick={() => openChat({ kind: "existing", threadId: link.threadId, sessionFile: null })}
        >
          {link.title ?? "Open the chat"}
        </button>
      );
  }
}

/** The question records `QuestionFields` draws, made from a thread's ask. */
const recordOf = (ask: string, question: WorkThreadQuestion, askedAt: number): QuestionRecord => ({
  id: `${ask}:${question.id}`,
  toolCallId: ask,
  questionId: question.id,
  question: question.question,
  ...(question.header === undefined ? {} : { header: question.header }),
  ...(question.context === undefined ? {} : { context: question.context }),
  options: question.options,
  multi: question.multi,
  ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
  askedAt,
  answer: null,
});

/** Each ask's latest answers and the questions already sent, read from the timeline. */
export function asksIn(
  entries: readonly WorkThreadEntry[],
): Map<string, { answers: Map<string, WorkThreadAnswer>; sent: Set<string> }> {
  const asks = new Map<string, { answers: Map<string, WorkThreadAnswer>; sent: Set<string> }>();
  for (const entry of entries) {
    if (entry.type === "question") asks.set(entry.id, { answers: new Map(), sent: new Set() });
    else if (entry.type === "answer")
      asks.get(entry.ask)?.answers.set(entry.questionId, entry.answer);
    else if (entry.type === "sent")
      for (const id of entry.questionIds) asks.get(entry.ask)?.sent.add(id);
  }
  return asks;
}

export function ThreadView({
  client,
  id,
  chat,
  openChat,
  onBack,
}: {
  readonly client: AppClient;
  readonly id: WorkThreadId;
  /** The chat you are in: what stops it shows atop its threads too. */
  readonly chat: ChatController | null;
  readonly openChat?: (target: ChatTarget) => void;
  readonly onBack: () => void;
}): ReactNode {
  const read = useWorkThread(client, id);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>): void => {
    setBusy(true);
    setProblem(null);
    work()
      .catch((failure: unknown) => setProblem(failureText(failure)))
      .finally(() => setBusy(false));
  };
  const back = (
    <Button size="sm" variant="ghost" className="self-start" onClick={onBack}>
      <ArrowLeft />
      Threads
    </Button>
  );
  if (read === null)
    return (
      <div className="flex flex-col gap-2 px-2 py-1.5">
        {back}
        <p className="px-1 text-sm text-t3">Reading the thread…</p>
      </div>
    );
  const { summary, entries } = read;
  const asks = asksIn(entries);
  const send = (): void => {
    const text = reply.trim();
    if (text === "") return;
    run(async () => {
      await client.port(WorkThreadsPort).message({ id, text });
      setReply("");
    });
  };
  return (
    <section
      data-tour="workbench-panel"
      aria-label={`Thread: ${summary.title}`}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-l2 px-2 py-1.5">
        {back}
        <h2 className="px-1 text-sm font-medium text-t1">{summary.title}</h2>
        <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-t3">
          <span>{kindLabel(summary.kind)}</span>
          <label className="flex items-center gap-1">
            <span className="sr-only">State</span>
            <select
              aria-label="State"
              className="rounded-md border border-l2 bg-l1 px-1.5 py-0.5 text-xs text-t1"
              value={summary.state}
              disabled={busy}
              onChange={(event) =>
                run(() =>
                  client
                    .port(WorkThreadsPort)
                    .setState({ id, state: event.target.value as WorkThreadState }),
                )
              }
            >
              {Object.entries(STATE_LABELS).map(([state, label]) => (
                <option key={state} value={state}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {summary.owner !== null && openChat !== undefined && (
            <button
              type="button"
              className="text-accent-ink underline"
              onClick={() =>
                openChat({
                  kind: "existing",
                  threadId: summary.owner as ThreadId,
                  sessionFile: null,
                })
              }
            >
              Open its chat
            </button>
          )}
        </div>
        {summary.progress !== null && (
          <div className="flex flex-col gap-1 px-1">
            <ProgressBar thread={summary} />
            {summary.progress.steps !== undefined && (
              <ol aria-label="Steps" className="flex flex-col gap-0.5 text-xs">
                {summary.progress.steps.map((step, at) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: the steps of one plan, in order; names may repeat
                    key={`${at}-${step}`}
                    className={
                      at < (summary.progress?.done ?? 0) ? "text-t3 line-through" : "text-t2"
                    }
                  >
                    {at + 1}. {step}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {summary.links.length > 0 && (
          <ul aria-label="Links" className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs">
            {summary.links.map((link) => (
              <li key={JSON.stringify(link)}>
                <LinkLine link={link} openChat={openChat} />
              </li>
            ))}
          </ul>
        )}
      </header>
      {chat !== null && summary.owner === chat.threadId && (
        <div className="shrink-0 pt-2">
          <ChatStops controller={chat} />
        </div>
      )}
      <ol
        aria-label="Timeline"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2"
      >
        {/* Answers and their sending show in their ask's card, not as rows of their own. */}
        {entries
          .filter((entry) => entry.type !== "answer" && entry.type !== "sent")
          .map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1">
              <span className="text-xs text-t3">
                {whoOf(entry)} · {WHEN.format(entry.at)}
              </span>
              <EntryBody
                client={client}
                thread={id}
                entry={entry}
                ask={entry.type === "question" ? asks.get(entry.id) : undefined}
              />
            </li>
          ))}
      </ol>
      <footer className="flex shrink-0 flex-col gap-1.5 border-t border-l2 px-2 py-2">
        <Textarea
          aria-label="Write in the thread"
          rows={2}
          placeholder={
            summary.owner === null
              ? "Write in the thread (the main chat gets it)"
              : "Write in the thread (its chat gets it)"
          }
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={onCtrlEnter(send)}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy || reply.trim() === ""} onClick={send}>
            Send
          </Button>
          {problem !== null && (
            <span role="alert" className="text-xs text-bad-ink">
              {problem}
            </span>
          )}
        </div>
      </footer>
    </section>
  );
}

function EntryBody({
  client,
  thread,
  entry,
  ask,
}: {
  readonly client: AppClient;
  readonly thread: WorkThreadId;
  readonly entry: WorkThreadEntry;
  readonly ask: { answers: Map<string, WorkThreadAnswer>; sent: Set<string> } | undefined;
}): ReactNode {
  switch (entry.type) {
    case "created":
    case "message":
      return (
        <div className="text-sm text-t1">
          <Markdown text={entry.text} />
        </div>
      );
    case "update":
      return (
        <div className="text-sm text-t1">
          {entry.progress !== undefined && (
            <span className="text-xs text-t3">
              Step {entry.progress.done} of {entry.progress.total}
            </span>
          )}
          <Markdown text={entry.text} />
        </div>
      );
    case "progress":
      return (
        <span className="text-xs text-t2">
          Step {entry.progress.done} of {entry.progress.total}
        </span>
      );
    case "question":
      return <AskCard client={client} thread={thread} entry={entry} ask={ask} />;
    case "answer":
    case "sent":
      return null;
    case "link":
      return (
        <span className="text-xs text-t2">
          Linked <LinkLine link={entry.link} />
        </span>
      );
    case "state":
      return <span className="text-xs text-t2">Set to {STATE_LABELS[entry.state]}</span>;
    case "owner":
      return (
        <span className="text-xs text-t2">
          {entry.owner === null ? "No chat owns it now" : "Handed to a chat"}
        </span>
      );
  }
}

/** A thread's ask: its questions to answer, with Send; once every one went to the chat, the answers folded. */
export function AskCard({
  client,
  thread,
  entry,
  ask,
}: {
  readonly client: AppClient;
  readonly thread: WorkThreadId;
  readonly entry: WorkThreadEntry & { type: "question" };
  readonly ask: { answers: Map<string, WorkThreadAnswer>; sent: Set<string> } | undefined;
}): ReactNode {
  const records = entry.questions.map((question) => recordOf(entry.id, question, entry.at));
  const sent = ask?.sent ?? new Set<string>();
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(
    () =>
      new Map(
        records.map((record) => {
          const held = ask?.answers.get(record.questionId);
          return [
            record.questionId,
            draftOf(record, held === undefined ? null : { ...held, answeredAt: entry.at }),
          ];
        }),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formId = useId();
  const open = records.filter((record) => !sent.has(record.questionId));
  if (open.length === 0)
    return (
      <section
        aria-label="Answered questions"
        className="flex flex-col gap-1 rounded-lg border border-l2 px-3 py-2 text-xs"
      >
        {records.map((record) => {
          const answer = ask?.answers.get(record.questionId);
          return (
            <p key={record.id} className="text-t2">
              <span className="text-t1">{record.header ?? record.question}</span>:{" "}
              {answer === undefined || answer.skipped
                ? "skipped"
                : [...answer.picked, ...(answer.typed === undefined ? [] : [answer.typed])].join(
                    "; ",
                  )}
            </p>
          );
        })}
      </section>
    );
  const ready = open.filter((record) => decided(drafts.get(record.questionId) as Draft));
  const all = ready.length === open.length;
  const send = (): void => {
    if (ready.length === 0) return;
    setBusy(true);
    setProblem(null);
    void (async () => {
      const port = client.port(WorkThreadsPort);
      for (const record of ready) {
        const draft = drafts.get(record.questionId) as Draft;
        await port.answer({
          id: thread,
          ask: entry.id,
          questionId: record.questionId,
          answer: draft.skipped
            ? { picked: [], skipped: true }
            : {
                picked: [...draft.picked],
                ...(draft.typed === undefined || draft.typed.trim() === ""
                  ? {}
                  : { typed: draft.typed.trim() }),
                ...(draft.note === undefined || draft.note.trim() === ""
                  ? {}
                  : { note: draft.note.trim() }),
                skipped: false,
              },
        });
      }
      // Every question answered: the server sent them together. Some left: the ready ones go now.
      if (!all) await port.sendAnswers({ id: thread, ask: entry.id });
    })()
      .catch((failure: unknown) => setProblem(failureText(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <section
      id={formId}
      aria-label={`Questions: ${open.map((record) => record.header ?? record.question).join(", ")}`}
      className="flex flex-col gap-3 rounded-lg border border-l3 bg-card px-3 py-2.5"
      onKeyDown={onCtrlEnter(send)}
    >
      {open.map((record) => (
        <QuestionFields
          key={record.id}
          record={record}
          draft={drafts.get(record.questionId) as Draft}
          onChange={(draft) =>
            setDrafts((current) => new Map(current).set(record.questionId, draft))
          }
          onEnter={() => undefined}
        />
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || ready.length === 0} onClick={send}>
          {all ? "Send answers" : `Send the ${ready.length} ready`}
        </Button>
        {problem !== null && (
          <span role="alert" className="text-xs text-bad-ink">
            {problem}
          </span>
        )}
      </div>
    </section>
  );
}

/** New thread in this chat's Workbench: its title, kind and what you want; the chat takes it up and answers in it. */
function NewThread({
  client,
  here,
  onOpened,
  onCancel,
}: {
  readonly client: AppClient;
  /** The chat whose Workbench it is. */
  readonly here: ThreadId;
  readonly onOpened: (id: WorkThreadId) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkThreadKind>("task");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ok = title.trim() !== "" && text.trim() !== "";
  const open = (): void => {
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    client
      .port(WorkThreadsPort)
      .open({
        title: title.trim(),
        kind,
        text: text.trim(),
        to: { kind: "chat", threadId: here },
      })
      .then((thread) => onOpened(thread.id))
      .catch((failure: unknown) => setProblem(failureText(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <section
      data-tour="workbench-panel"
      aria-label="New thread"
      className="flex flex-col gap-3 px-3 py-2"
      onKeyDown={onCtrlEnter(open)}
    >
      <h2 className="text-sm font-medium text-t1">New thread</h2>
      <Input
        aria-label="Title"
        placeholder="Title: the bug or feature, in a few words"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <RadioGroup
        aria-label="Kind"
        value={kind}
        onValueChange={(value) => setKind(value as WorkThreadKind)}
        className="flex flex-wrap gap-3"
      >
        {KINDS.map((one) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
          <label key={one.kind} className="flex items-center gap-1.5 text-sm text-t1">
            <RadioGroupItem value={one.kind} aria-label={one.label} />
            {one.label}
          </label>
        ))}
      </RadioGroup>
      <Textarea
        aria-label="What you want"
        rows={5}
        placeholder="What it is about, and what done looks like"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !ok} onClick={open}>
          Open the thread
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {problem !== null && (
          <span role="alert" className="text-xs text-bad-ink">
            {problem}
          </span>
        )}
      </div>
    </section>
  );
}
