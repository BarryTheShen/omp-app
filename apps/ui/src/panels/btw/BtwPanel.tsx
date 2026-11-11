import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BtwRecord, type BtwTurn, copyText, latestTurn, turnsOf } from "../../btw/btw";
import type { ChatController } from "../../chat/controller";
import { writeClipboard } from "../../clipboard";
import { isImeEnter } from "../../keys/ime";
import { useWaiting } from "../../questions/waiting";
import {
  Markdown,
  StreamingMarkdown,
} from "../../vendor/collab-web/components/transcript/Markdown";
import { QuestionsTab } from "./QuestionCard";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** omp's times in its history (its `#timeFormat` and `#dateFormat`): a topic's time, and its first question's date. */
const TIME = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DATE = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const isRunning = (record: BtwRecord): boolean => latestTurn(record).status === "running";

/** A status worth naming next to an answer, in omp's words; an answered question needs none. */
function Status({ status }: { readonly status: BtwTurn["status"] }): ReactNode {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-accent-ink">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          Answering
        </span>
      );
    case "cancelled":
      return <span className="text-warn-ink">Cancelled</span>;
    case "error":
      return <span className="text-bad-ink">Failed</span>;
    case "interrupted":
      return <span className="text-warn-ink">Interrupted</span>;
    case "complete":
      return null;
  }
}

/** A question as a row's label: its `code` in the monospace face, without the backticks, as omp shows it. */
function QuestionLabel({ text }: { readonly text: string }): ReactNode {
  return text.split(/`([^`]+)`/).map((part, index) => {
    if (part === "") return null;
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, in their order
    if (index % 2 === 0) return <span key={index}>{part}</span>;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, in their order
      <code key={index} className="font-mono text-[0.95em]">
        {part}
      </code>
    );
  });
}

/** A button that names its key in its tooltip, as omp's history does. */
function KeyButton({
  label,
  keyName,
  ariaKeys,
  primary = false,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  /** The key as the tooltip says it: "Esc", "Enter", "X". */
  readonly keyName: string;
  /** The key for `aria-keyshortcuts`: "Escape", "Enter", "x". */
  readonly ariaKeys: string;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={primary ? "default" : "outline"}
            disabled={disabled}
            aria-keyshortcuts={ariaKeys}
            onClick={onClick}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>
        {label} ({keyName})
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One question of a topic and its answer. The question sits on a card, as your messages do in the chat, under a line
 * that says when you asked it; the answer follows it as plain text, as omp's replies do.
 */
function Turn({ turn, index }: { readonly turn: BtwTurn; readonly index: number }): ReactNode {
  const answered = turn.answer.trim() !== "";
  return (
    <article className="flex flex-col gap-1.5" aria-label={index === 0 ? "Question" : "Follow-up"}>
      <p className="flex items-center gap-1.5 text-xs text-t3">
        <span>
          {index === 0 ? DATE.format(turn.createdAt) : `Follow-up · ${TIME.format(turn.createdAt)}`}
        </span>
        {turn.status !== "complete" && (
          <>
            <span aria-hidden>·</span>
            <Status status={turn.status} />
          </>
        )}
      </p>
      <section
        aria-label="Your question"
        className="max-w-full self-start rounded-xl border border-border bg-card px-3.5 py-2 text-t1"
      >
        <Markdown text={turn.question} />
      </section>
      <section aria-label="Answer" className="flex flex-col gap-1.5 pt-1">
        {/* A failed turn with no text says only why it failed. */}
        {(answered || turn.error === undefined) &&
          (answered ? (
            turn.status === "running" ? (
              <StreamingMarkdown text={turn.answer} />
            ) : (
              <Markdown text={turn.answer} />
            )
          ) : (
            <p className="text-t3">{turn.status === "running" ? "Thinking…" : "No answer text."}</p>
          ))}
        {turn.error !== undefined && <p className="text-bad-ink">{turn.error}</p>}
        {turn.status === "interrupted" && <p className="text-t3">Not resumed in this view.</p>}
      </section>
    </article>
  );
}

/**
 * The Questions panel, beside the chat it belongs to (the focused pane's), in two tabs: the questions the chat's agent
 * asked without waiting (Questions for you), and the side questions asked with omp's `/btw` (its BTW history). It opens
 * on the questions when one waits; `/btw` brings the side questions forward.
 */
export function BtwPanel({ chat }: { readonly chat: ChatController | null }): ReactNode {
  if (chat === null)
    return <p className="px-4 py-3 text-[0.8125rem] text-t3">Open a chat to see its questions.</p>;
  return <BtwTabs controller={chat} />;
}

type BtwTab = "questions" | "side";

function BtwTabs({ controller }: { readonly controller: ChatController }): ReactNode {
  const { records } = useSyncExternalStore(
    controller.questions.subscribe,
    controller.questions.getSnapshot,
  );
  // The open questions and a plan to review: the tab's count, and the tab the panel opens on.
  const open = useWaiting(controller);
  // Read as a yes or no, so the pieces of a side answer do not redraw the tabs.
  const sideWanted = useSyncExternalStore(
    controller.btw.subscribe,
    () => controller.btw.getSnapshot().wanted,
  );
  const [picked, setPicked] = useState<BtwTab | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Another chat focused: its own tab is decided again (React's way of resetting state for a new prop).
  const [owner, setOwner] = useState(controller);
  if (owner !== controller) {
    setOwner(controller);
    setPicked(null);
    setProblem(null);
  }

  // The questions are read each time the panel shows, as the side questions are.
  useEffect(() => {
    let alive = true;
    controller
      .loadQuestions()
      .catch((failure: unknown) => alive && setProblem(failureText(failure)));
    return () => {
      alive = false;
    };
  }, [controller]);

  // Once the questions are known, the panel stays on the tab it opened on until the person picks one.
  const known = records !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once a chat's questions are first known
  useEffect(() => {
    if (known && picked === null) setPicked(open > 0 ? "questions" : "side");
  }, [known, picked]);
  // `/btw` (a side question asked, or the history opened) brings the side questions forward, also while questions wait.
  // After the effect above, so it wins when both run at once.
  useEffect(() => {
    if (!sideWanted) return;
    setPicked("side");
    controller.btw.revealed();
  }, [sideWanted, controller]);
  const tab: BtwTab = picked ?? (open > 0 ? "questions" : "side");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Questions"
        className="flex shrink-0 gap-1 border-b border-l2 p-1.5"
      >
        <TabButton selected={tab === "questions"} onClick={() => setPicked("questions")}>
          Questions for you
          {open > 0 && (
            <>
              {" "}
              <span className="ml-1 rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground">
                {open}
              </span>
            </>
          )}
        </TabButton>
        <TabButton selected={tab === "side"} onClick={() => setPicked("side")}>
          Side questions
        </TabButton>
      </div>
      {tab === "questions" ? (
        problem !== null && records === null ? (
          <p className="px-4 py-3 text-[0.8125rem] text-t3">{problem}</p>
        ) : (
          <QuestionsTab controller={controller} />
        )
      ) : (
        <BtwHistory controller={controller} />
      )}
    </div>
  );
}

/** One of the panel's two tabs; on a phone 44 px tall, a finger's target, as the app's other tabs. */
function TabButton({
  selected,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex items-center rounded-md px-2.5 py-1 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 max-sm:px-3 ${
        selected ? "bg-l2 text-t1" : "text-t3 hover:bg-l1 hover:text-t1"
      }`}
    >
      {children}
    </button>
  );
}

function BtwHistory({ controller }: { readonly controller: ChatController }): ReactNode {
  const { records, selected, session } = useSyncExternalStore(
    controller.btw.subscribe,
    controller.btw.getSnapshot,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  /** Whether the thread follows its newest text: until the reader scrolls up. */
  const following = useRef(true);
  const fieldId = useId();

  // While this is drawn, the chat's side questions are on screen: an answer of the chat's ends without a word.
  useEffect(() => {
    controller.btw.setShown(true);
    return () => controller.btw.setShown(false);
  }, [controller]);

  // omp's history is read each time it is shown (omp's terminal may have asked some), and for a new session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a move to another session reads that session's side questions
  useEffect(() => {
    let alive = true;
    setProblem(null);
    controller
      .loadBtw()
      .catch(
        (failure: unknown) =>
          alive && setProblem(`Could not read the side questions: ${failureText(failure)}`),
      );
    return () => {
      alive = false;
    };
  }, [session, controller]);

  const current = records?.find((record) => record.id === selected) ?? records?.[0];
  const currentId = current?.id;
  const anyRunning = records?.some(isRunning) ?? false;
  const canFollowUp = current !== undefined && !pending && !anyRunning;
  const copyable = current !== undefined && copyText(current) !== undefined;
  const copied = copiedId !== null && copiedId === currentId;
  const turns = current === undefined ? [] : turnsOf(current);
  const answered = turns.reduce((length, turn) => length + turn.answer.length + 1, 0);

  // The follow-up field belongs to one topic of one chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another topic or another chat starts without the field
  useEffect(() => {
    setComposing(false);
    setNotice(null);
  }, [currentId, controller]);

  // A topic opens at its newest turn, and the thread follows the answer as it comes until the reader scrolls up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another topic is picked
  useEffect(() => {
    following.current = true;
  }, [currentId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the topic's text grows or the field opens
  useEffect(() => {
    const thread = threadRef.current;
    if (thread !== null && following.current) thread.scrollTop = thread.scrollHeight;
  }, [currentId, answered, composing]);

  const stop = (): void => {
    if (current === undefined) return;
    controller
      .cancelBtw(current.id)
      .catch((failure: unknown) =>
        setProblem(`Could not stop the answer: ${failureText(failure)}`),
      );
  };

  const copy = (): void => {
    if (current === undefined) return;
    const text = copyText(current);
    if (text === undefined) return;
    const id = current.id;
    writeClipboard(text)
      .then(() => setCopiedId(id))
      .catch((failure: unknown) =>
        setProblem(`Could not copy the answer: ${failureText(failure)}`),
      );
  };

  const sendFollowUp = (): void => {
    const question = draft.trim();
    if (question === "") {
      setNotice("Enter a follow-up question.");
      return;
    }
    if (current === undefined || anyRunning || pending) {
      setNotice("A BTW request is busy. Try again when it finishes.");
      return;
    }
    setPending(true);
    setNotice(null);
    controller
      .askBtw(question, current.id)
      .then(() => {
        setComposing(false);
        setDraft("");
      })
      .catch((failure: unknown) => setNotice(failureText(failure)))
      .finally(() => setPending(false));
  };

  /** Moves the list's pick (arrows, Home, End), and the focus with it. */
  const onListKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (records === null || current === undefined) return;
    const at = records.findIndex((record) => record.id === current.id);
    const to =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? records.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = records[Math.max(0, Math.min(records.length - 1, to))];
    if (next === undefined) return;
    controller.btw.select(next.id);
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus(),
    );
  };

  /** The history's keys, as omp's: X stops the answer, C copies it, F (or Enter in the list) follows up. */
  const onKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("textarea, input") !== null) return;
    const key = event.key.toLowerCase();
    if (key === "x" && current !== undefined && isRunning(current)) {
      event.preventDefault();
      stop();
    } else if (key === "c" && copyable) {
      event.preventDefault();
      copy();
    } else if (
      (key === "f" || (event.key === "Enter" && target.getAttribute("role") === "option")) &&
      canFollowUp &&
      !composing
    ) {
      event.preventDefault();
      setComposing(true);
    }
  };

  const empty = records !== null && records.length === 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the history's keys (X, C, F) act anywhere inside it, as omp's
    <div data-tour="btw-panel" onKeyDown={onKeys} className="flex h-full min-h-0 flex-col">
      {records === null ? (
        <p className="px-4 py-3 text-[0.8125rem] text-t3">
          {problem === null ? "Reading the side questions…" : problem}
        </p>
      ) : empty ? (
        <div className="flex flex-col gap-2 px-4 py-6">
          <p className="font-medium text-t1">No side questions yet</p>
          <p className="text-[0.8125rem] text-t3">
            Ask one with <code className="font-mono">/btw &lt;question&gt;</code>. The answer stays
            out of the main conversation.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            role="listbox"
            aria-label="Side questions"
            onKeyDown={onListKeys}
            className="max-h-[38%] shrink-0 overflow-y-auto border-b border-l2 p-1.5"
          >
            {records.map((record) => {
              const picked = record.id === currentId;
              const followUps = record.followUps?.length ?? 0;
              return (
                <div
                  key={record.id}
                  data-id={record.id}
                  role="option"
                  aria-selected={picked}
                  tabIndex={picked ? 0 : -1}
                  onClick={() => controller.btw.select(record.id)}
                  onKeyDown={(event) => {
                    if (event.key === " ") {
                      event.preventDefault();
                      controller.btw.select(record.id);
                    }
                  }}
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    picked ? "bg-l2" : "hover:bg-l1"
                  }`}
                >
                  <span className="line-clamp-2 text-[0.8125rem] text-t1">
                    <QuestionLabel text={record.question} />
                  </span>
                  <span
                    className={`flex items-center gap-1.5 text-xs ${picked ? "text-t1" : "text-t3"}`}
                  >
                    <span className="font-mono">{TIME.format(record.createdAt)}</span>
                    {followUps > 0 && (
                      <span>
                        · {followUps} follow-up{followUps === 1 ? "" : "s"}
                      </span>
                    )}
                    <span className="ml-auto">
                      <Status status={latestTurn(record).status} />
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <section
            ref={threadRef}
            aria-label="Side question"
            onScroll={(event) => {
              const thread = event.currentTarget;
              following.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
            }}
            className="tr-root flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3 text-[0.8125rem]"
          >
            {turns.map((turn, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a topic's turns only grow at the end
              <Turn key={index} turn={turn} index={index} />
            ))}
            {composing && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={fieldId} className="text-xs font-medium text-accent-ink">
                  Follow up:
                </label>
                <Textarea
                  id={fieldId}
                  autoFocus
                  rows={2}
                  value={draft}
                  placeholder="Ask about this answer…"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setNotice(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setComposing(false);
                    } else if (event.key === "Enter" && !event.shiftKey && !isImeEnter(event)) {
                      event.preventDefault();
                      sendFollowUp();
                    }
                  }}
                />
                {notice !== null && <p className="text-xs text-warn-ink">{notice}</p>}
              </div>
            )}
          </section>
        </>
      )}
      {records !== null && problem !== null && (
        <p role="alert" className="border-t border-l2 px-4 py-2 text-xs text-bad-ink">
          {problem}
        </p>
      )}
      {current !== undefined && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-l2 px-3 py-2.5">
          {composing ? (
            <>
              <span className="flex-1" />
              <KeyButton
                label="Cancel"
                keyName="Esc"
                ariaKeys="Escape"
                onClick={() => setComposing(false)}
              />
              <KeyButton
                label={pending ? "Sending…" : "Send"}
                keyName="Enter"
                ariaKeys="Enter"
                primary
                disabled={pending}
                onClick={sendFollowUp}
              />
            </>
          ) : (
            <>
              {isRunning(current) && (
                <KeyButton label="Stop answer" keyName="X" ariaKeys="x" onClick={stop} />
              )}
              {copyable && (
                <KeyButton
                  label={copied ? "Copy again" : "Copy answer"}
                  keyName="C"
                  ariaKeys="c"
                  onClick={copy}
                />
              )}
              {copyable && copied && <span className="text-xs text-ok-ink">✓ Copied</span>}
              <span className="flex-1" />
              {canFollowUp && (
                <KeyButton
                  label="Follow up"
                  keyName="F"
                  ariaKeys="f"
                  primary
                  onClick={() => setComposing(true)}
                />
              )}
            </>
          )}
        </footer>
      )}
    </div>
  );
}
