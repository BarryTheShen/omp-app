import type { AskDialog, HostDialogAnswer } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { KEYS, keycap } from "../keys/table";
import { useSidewaysRow } from "../sidewaysRow";
import { matchesHotkey } from "../tour/keys";
import { Markdown } from "../vendor/collab-web/components/transcript/Markdown";

type Question = AskDialog["questions"][number];

/** What is chosen for one question: its options, a typed answer (Other…), and a note on the answer. */
interface Chosen {
  readonly picked: readonly string[];
  /** The typed answer; undefined while Other… is not chosen. */
  readonly typed: string | undefined;
  /** The note; undefined while there is none. */
  readonly note: string | undefined;
}

const NONE: Chosen = { picked: [], typed: undefined, note: undefined };

/** The radio value of Other…: no option of omp's can have it, as omp reserves its own rows' labels. */
const OTHER = "\u0000other";

const answered = (chosen: Chosen | undefined): boolean =>
  chosen !== undefined && (chosen.picked.length > 0 || (chosen.typed ?? "").trim() !== "");

/** A question's name on its tab and in Review, as omp names it: its header, else its id, else Q1, Q2… */
const tabName = (question: Question, index: number): string =>
  question.header?.trim() || question.id.trim() || `Q${index + 1}`;

/** An answer in a few words for Review: the options chosen and the typed answer, or Unanswered. */
function summary(chosen: Chosen): string {
  const parts = [...chosen.picked];
  const typed = chosen.typed?.trim();
  if (typed) parts.push(typed);
  return parts.length === 0 ? "Unanswered" : parts.join(", ");
}

/** Seconds left of omp's Ask Timeout, counted from when the questions showed; undefined without one. */
function useSecondsLeft(timeout: number | undefined): number | undefined {
  const [deadline] = useState(() => (timeout === undefined ? undefined : Date.now() + timeout));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1000));
}

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * omp's questions (#2795), as omp's own question dialog asks them: one question at a time, a tab for each and a Review
 * tab when there are two or more; answers with their descriptions, the recommended one marked, Other… for a typed
 * answer, and the highlighted answer's preview; Hide, Note, and one button to go on: Skip while the question has no
 * answer, Next once it has one (#2804), Submit on the last; and omp's keys (Esc skips them all). Hide folds it to one
 * line above the message box until Show.
 */
export function QuestionsDialog({
  dialog,
  busy,
  error,
  waiting,
  onAnswer,
}: {
  readonly dialog: AskDialog;
  readonly busy: boolean;
  readonly error: string | null;
  readonly waiting: number;
  readonly onAnswer: (answer: HostDialogAnswer) => void;
}): ReactNode {
  const { questions } = dialog;
  const count = questions.length;
  /** The Review tab's index; with one question there is none. */
  const reviewTab = count > 1 ? count : null;
  const [tab, setTab] = useState(0);
  const [chosen, setChosen] = useState<readonly Chosen[]>(() => questions.map(() => NONE));
  const [highlight, setHighlight] = useState<readonly number[]>(() =>
    questions.map((question) => question.recommended ?? 0),
  );
  const [hidden, setHidden] = useState(false);
  const tabRow = useSidewaysRow(tab);
  const root = useRef<HTMLDivElement | null>(null);
  /** What to focus once the next render is on screen: a row, the typed answer, or the note. */
  const focusNext = useRef<string | null>(null);
  const secondsLeft = useSecondsLeft(dialog.timeout);

  useEffect(() => {
    const selector = focusNext.current;
    if (selector === null) return;
    focusNext.current = null;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  // omp's Alt+H (`app.ask.hide`) anywhere in this chat's window (the workspace's `data-chat-pane`; the whole page where
  // no window holds the chat); an open menu that takes the key first keeps it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !matchesHotkey(event, KEYS.askHide.hotkey)) return;
      const pane = root.current?.closest("[data-chat-pane]") ?? document.body;
      if (!(event.target instanceof Node) || !pane.contains(event.target)) return;
      event.preventDefault();
      setHidden((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (index: number, next: (current: Chosen) => Chosen): void =>
    setChosen((all) => all.map((current, at) => (at === index ? next(current) : current)));

  const goTo = (next: number): void => {
    setTab(next);
    if (next < count) focusNext.current = `[data-row="${highlight[next] ?? 0}"]`;
  };

  /** Sends `all`: the answers as chosen, or as a keystroke has just chosen them (state not yet on screen). */
  const submit = (all: readonly Chosen[] = chosen): void =>
    onAnswer({
      answers: questions.map((question, index) => {
        const current = all[index] ?? NONE;
        const typed = current.typed?.trim();
        const note = current.note?.trim();
        return {
          id: question.id,
          selectedOptions: [...current.picked],
          ...(typed ? { customInput: typed } : {}),
          ...(note ? { note } : {}),
        };
      }),
    });

  const skip = (): void => onAnswer({ cancelled: true });

  const onLastStep = tab === reviewTab || (reviewTab === null && tab === count - 1);
  /** A lone single-answer question needs an answer: sent empty, omp reads it as skipped. */
  const canSubmit = (all: readonly Chosen[] = chosen): boolean => {
    const only = questions[0];
    return !(count === 1 && only !== undefined && only.multi !== true && !answered(all[0]));
  };

  /** Next, or Submit on the last question and on Review. */
  const primary = (all: readonly Chosen[] = chosen): void => {
    if (!onLastStep) goTo(tab + 1);
    else if (canSubmit(all)) submit(all);
  };

  /** The question on screen has no answer yet: the button to go on skips it (#2804), a lone question too. */
  const skipsThis = tab < count && !answered(chosen[tab]);
  const goOn = (): void => {
    if (skipsThis && onLastStep) skip();
    else primary();
  };
  const goOnLabel = skipsThis ? "Skip" : onLastStep ? "Submit" : "Next";

  /** A single answer's option chosen: the answers with it, which the caller may send at once. */
  const choose = (index: number, label: string): readonly Chosen[] => {
    const all = chosen.map((current, at) =>
      at === index ? { ...current, picked: [label], typed: undefined } : current,
    );
    setChosen(all);
    const at = questions[index]?.options.findIndex((option) => option.label === label) ?? -1;
    if (at >= 0) setHighlight((marks) => marks.map((value, i) => (i === index ? at : value)));
    return all;
  };

  /** A click on a single answer is Enter on it, as in omp: chosen, and on to the next question or Review; never sent. */
  const clickChoice = (index: number, label: string): void => {
    choose(index, label);
    if (index < count - 1) goTo(index + 1);
    else if (reviewTab !== null) goTo(reviewTab);
  };

  const openOther = (index: number): void => {
    update(index, (current) => ({
      ...current,
      picked: questions[index]?.multi === true ? current.picked : [],
      typed: current.typed ?? "",
    }));
    focusNext.current = "[data-typed]";
  };

  const openNote = (index: number): void => {
    update(index, (current) => ({ ...current, note: current.note ?? "" }));
    focusNext.current = "[data-note]";
  };

  /** × beside the note (#2803): the note goes, and the highlighted answer has the keyboard again. */
  const removeNote = (index: number): void => {
    update(index, (current) => ({ ...current, note: undefined }));
    focusNext.current = `[data-row="${highlight[index] ?? 0}"]`;
  };

  // omp's keys in the dialog: Enter chooses and moves on, Tab and Shift+Tab change question, N adds a note, Esc
  // skips; Arrow keys move between tick boxes (round marks move by themselves). In a text box, its own keys win.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null) return;
    const typing = target.matches("textarea, input:not([type='checkbox']):not([type='radio'])");
    const row = target.closest<HTMLElement>("[data-row]");
    const question = tab < count ? questions[tab] : undefined;
    const stop = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      stop();
      if (target.matches("[data-typed]") && question !== undefined) {
        update(tab, (current) => ({ ...current, typed: undefined }));
        focusNext.current = `[data-row="other"]`;
      } else if (target.matches("[data-note]")) {
        if ((chosen[tab]?.note ?? "").trim() === "")
          update(tab, (current) => ({ ...current, note: undefined }));
        focusNext.current = `[data-row="${highlight[tab] ?? 0}"]`;
      } else skip();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (target.matches("textarea")) return;
      if (target.matches("button:not([data-row]), a")) return;
      stop();
      let all = chosen;
      if (row !== null && question !== undefined && question.multi !== true) {
        const label = row.dataset.option;
        if (label !== undefined) all = choose(tab, label);
        else if (row.dataset.row === "other" && chosen[tab]?.typed === undefined) {
          openOther(tab);
          return;
        }
      }
      primary(all);
      return;
    }
    if (typing) return;
    if (event.key === "Tab" && reviewTab !== null) {
      const next = tab + (event.shiftKey ? -1 : 1);
      if (next < 0 || next > reviewTab) return;
      stop();
      goTo(next);
      return;
    }
    if ((event.key === "n" || event.key === "N") && !event.shiftKey && question !== undefined) {
      stop();
      openNote(tab);
      return;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      row !== null &&
      question?.multi === true
    ) {
      const rows = [
        ...(root.current?.querySelectorAll<HTMLElement>("[role='tabpanel'] [data-row]") ?? []),
      ];
      const at = rows.indexOf(row);
      const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (next === undefined) return;
      stop();
      next.focus();
    }
  };

  const current = questions[tab];
  const shownQuestion = current ?? questions[0];
  const timer =
    secondsLeft === undefined ? null : (
      <span
        className="font-mono text-xs text-t3 tabular-nums"
        title="Answers the recommended option when the time runs out"
      >
        {clock(secondsLeft)}
      </span>
    );

  if (hidden)
    return (
      <div ref={root} className="flex min-h-0 flex-col">
        <section
          data-tour="questions-hidden"
          aria-label="Questions from omp, hidden"
          className="flex items-center gap-2 rounded-xl border border-l3 bg-card px-3 py-1.5 shadow-md"
        >
          {timer}
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="text-t3">Question </span>
            <span className="text-t1">{shownQuestion?.question}</span>
            {count > 1 && <span className="text-t3"> +{count - 1} more</span>}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={skip}
            title="Skip without answering  Esc"
          >
            {count > 1 ? "Skip all" : "Skip"}
          </Button>
          <Button
            size="sm"
            onClick={() => setHidden(false)}
            title={`Show the questions  ${keycap(KEYS.askHide)}`}
          >
            Show
          </Button>
        </section>
      </div>
    );

  return (
    <div ref={root} className="flex min-h-0 flex-col">
      <section
        role="dialog"
        data-tour="questions"
        aria-label="Questions from omp"
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-l3 bg-card shadow-md"
        onKeyDownCapture={onKeyDownCapture}
      >
        {reviewTab !== null && (
          <div
            ref={tabRow}
            role="tablist"
            aria-label="Questions"
            className="row-scroll flex shrink-0 gap-1 border-b border-l2 px-2 pt-1.5"
          >
            {[...questions.map((question, index) => tabName(question, index)), "Review"].map(
              (name, index) => {
                const selected = index === tab;
                const done = index < count && answered(chosen[index]);
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: the questions' order is their identity
                    key={index}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-t-md px-2.5 py-1.5 text-xs",
                      selected ? "bg-l2 text-t1" : "text-t3 hover:text-t1",
                    )}
                    onClick={() => goTo(index)}
                  >
                    {done && <Check aria-hidden className="size-3 text-accent-ink" />}
                    {name}
                    {done && <span className="sr-only"> (answered)</span>}
                  </button>
                );
              },
            )}
          </div>
        )}
        <div
          role="tabpanel"
          aria-label={current === undefined ? "Review" : tabName(current, tab)}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3"
        >
          {current === undefined ? (
            <Review questions={questions} chosen={chosen} onOpen={(index) => goTo(index)} />
          ) : (
            <QuestionBody
              key={tab}
              question={current}
              chosen={chosen[tab] ?? NONE}
              highlight={highlight[tab] ?? 0}
              lone={reviewTab === null}
              onHighlight={(at) =>
                setHighlight((all) => all.map((value, i) => (i === tab ? at : value)))
              }
              onChoose={(label) => choose(tab, label)}
              onClickChoice={(label) => clickChoice(tab, label)}
              onToggle={(label, on) =>
                update(tab, (now) => ({
                  ...now,
                  picked: on
                    ? [...now.picked, label]
                    : now.picked.filter((value) => value !== label),
                }))
              }
              onOther={(on) =>
                on ? openOther(tab) : update(tab, (now) => ({ ...now, typed: undefined }))
              }
              onTyped={(text) => update(tab, (now) => ({ ...now, typed: text }))}
              onNote={(text) => update(tab, (now) => ({ ...now, note: text }))}
              onRemoveNote={() => removeNote(tab)}
            />
          )}
        </div>
        {error !== null && <p className="shrink-0 px-3.5 pb-1 text-xs text-bad-ink">{error}</p>}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-l2 px-3.5 py-2">
          {timer}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setHidden(true)}
            title={`Hide until you are ready to answer  ${keycap(KEYS.askHide)}`}
          >
            Hide
          </Button>
          {waiting > 0 && (
            <span className="text-xs text-t3">
              {waiting === 1 ? "1 more is waiting." : `${waiting} more are waiting.`}
            </span>
          )}
          <span className="flex-1" />
          {current !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              title="Add a note to your answer  N"
              onClick={() => openNote(tab)}
            >
              Note
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || (goOnLabel === "Submit" && !canSubmit())}
            onClick={goOn}
            title={
              goOnLabel === "Skip"
                ? "Leave this question unanswered (Esc skips them all)"
                : `${goOnLabel}  Enter`
            }
          >
            {goOnLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** One question: its text, its answers (round marks for one, tick boxes for several), Other…, a preview and a note. */
function QuestionBody({
  question,
  chosen,
  highlight,
  lone,
  onHighlight,
  onChoose,
  onClickChoice,
  onToggle,
  onOther,
  onTyped,
  onNote,
  onRemoveNote,
}: {
  readonly question: Question;
  readonly chosen: Chosen;
  readonly highlight: number;
  /** The only question: its header shows above it, as there are no tabs. */
  readonly lone: boolean;
  readonly onHighlight: (at: number) => void;
  /** A value change: a click, or an arrow key in the round marks. */
  readonly onChoose: (label: string) => void;
  /** A pointer click on an answer's row, which also moves on (as Enter does in omp); arrow keys do not. */
  readonly onClickChoice: (label: string) => void;
  readonly onToggle: (label: string, on: boolean) => void;
  readonly onOther: (on: boolean) => void;
  readonly onTyped: (text: string) => void;
  readonly onNote: (text: string) => void;
  /** × beside the note: no note at all. */
  readonly onRemoveNote: () => void;
}): ReactNode {
  const multi = question.multi === true;
  const preview = question.options[highlight]?.preview?.trim();
  const otherOn = chosen.typed !== undefined;
  const otherRow = (
    <span className="flex min-w-0 flex-col">
      <span className="text-t1">Other…</span>
      <span className="text-xs text-t3">Type your own answer</span>
    </span>
  );
  return (
    <>
      {lone && question.header?.trim() && (
        <p className="text-xs text-t3">{question.header.trim()}</p>
      )}
      <div className="text-t1">
        <Markdown text={question.question} />
      </div>
      {multi ? (
        <fieldset className="flex min-w-0 flex-col gap-2" aria-label={question.question}>
          {question.options.map((option, at) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control
            <label
              key={option.label}
              className="flex items-start gap-2.5"
              onMouseEnter={() => onHighlight(at)}
            >
              <Checkbox
                className="mt-0.5"
                data-row={at}
                aria-label={option.label}
                checked={chosen.picked.includes(option.label)}
                onFocus={() => onHighlight(at)}
                onCheckedChange={(checked) => onToggle(option.label, checked === true)}
              />
              <OptionText
                label={option.label}
                description={option.description}
                recommended={question.recommended === at}
              />
            </label>
          ))}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control */}
          <label className="flex items-start gap-2.5">
            <Checkbox
              className="mt-0.5"
              data-row="other"
              aria-label="Other…"
              checked={otherOn}
              onCheckedChange={(checked) => onOther(checked === true)}
            />
            {otherRow}
          </label>
        </fieldset>
      ) : (
        <RadioGroup
          aria-label={question.question}
          value={otherOn ? OTHER : (chosen.picked[0] ?? null)}
          onValueChange={(value) => {
            if (value === OTHER) onOther(true);
            else if (typeof value === "string") onChoose(value);
          }}
        >
          {question.options.map((option, at) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
            // biome-ignore lint/a11y/useKeyWithClickEvents: the round mark inside takes the keys; Enter moves on
            <label
              key={option.label}
              className="flex items-start gap-2.5"
              onMouseEnter={() => onHighlight(at)}
              // A pointer's click has a count; a click made by keys or by the round marks' own code has none.
              onClick={(event) => {
                if (event.detail > 0) onClickChoice(option.label);
              }}
            >
              <RadioGroupItem
                className="mt-0.5"
                value={option.label}
                data-row={at}
                data-option={option.label}
                aria-label={option.label}
                onFocus={() => onHighlight(at)}
              />
              <OptionText
                label={option.label}
                description={option.description}
                recommended={question.recommended === at}
              />
            </label>
          ))}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className="flex items-start gap-2.5">
            <RadioGroupItem className="mt-0.5" value={OTHER} data-row="other" aria-label="Other…" />
            {otherRow}
          </label>
        </RadioGroup>
      )}
      {otherOn && (
        <Input
          data-typed
          aria-label={`Your own answer: ${question.question}`}
          placeholder="Type your own answer"
          value={chosen.typed ?? ""}
          onChange={(event) => onTyped(event.target.value)}
        />
      )}
      {preview && (
        <section
          aria-label="Preview"
          className="max-h-48 shrink-0 overflow-auto rounded-lg border border-l2 bg-(--code-bg) px-3 py-2 text-xs"
        >
          <Markdown text={preview} />
        </section>
      )}
      {chosen.note !== undefined && (
        <div className="flex items-start gap-2">
          <Textarea
            data-note
            aria-label="Note on your answer"
            placeholder="A note the agent gets with your answer"
            className="min-h-16"
            value={chosen.note}
            onChange={(event) => onNote(event.target.value)}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove the note"
            onClick={onRemoveNote}
          >
            <X />
          </Button>
        </div>
      )}
    </>
  );
}

/** Review: what is still unanswered, then each question with its answer; a question opens its tab. */
function Review({
  questions,
  chosen,
  onOpen,
}: {
  readonly questions: AskDialog["questions"];
  readonly chosen: readonly Chosen[];
  readonly onOpen: (index: number) => void;
}): ReactNode {
  const unanswered = questions.filter((_, index) => !answered(chosen[index])).length;
  return (
    <>
      <p className="text-sm">
        {unanswered === 0 ? (
          <span className="text-t2">All answered · Submit sends them</span>
        ) : (
          <>
            <span className="text-warn-ink">{unanswered} unanswered</span>
            <span className="text-t2">
              {" "}
              · Submit still sends {unanswered === questions.length ? "the questions" : "the rest"}
            </span>
          </>
        )}
      </p>
      <dl className="flex flex-col gap-1.5">
        {questions.map((question, index) => {
          const current = chosen[index] ?? NONE;
          const note = current.note?.trim();
          return (
            <div key={question.id} className="flex min-w-0 flex-col">
              <dt>
                <button
                  type="button"
                  className="text-left text-xs text-t3 hover:text-t1"
                  onClick={() => onOpen(index)}
                >
                  {tabName(question, index)}: {question.question}
                </button>
              </dt>
              <dd className={cn("break-words text-sm", answered(current) ? "text-t1" : "text-t3")}>
                {summary(current)}
                {note && <span className="text-t3"> · note: {note}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

/** An answer's label with its description, and omp's Recommended mark. */
export function OptionText({
  label,
  description,
  recommended,
}: {
  readonly label: string;
  readonly description: string | undefined;
  readonly recommended: boolean;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="break-words text-t1">
        {label}
        {recommended && (
          <span className="ml-2 rounded-sm bg-l2 px-1.5 py-0.5 text-[11px] text-accent-ink">
            Recommended
          </span>
        )}
      </span>
      {description !== undefined && (
        <span className="break-words text-xs text-t3">{description}</span>
      )}
    </span>
  );
}
