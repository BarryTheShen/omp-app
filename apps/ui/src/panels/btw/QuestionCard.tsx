import type { QuestionRecord } from "@omp-app/contracts/chat-host";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ChatController } from "../../chat/controller";
import { OptionText } from "../../chat/QuestionsDialog";
import { isImeEnter } from "../../keys/ime";
import { answerSummary, inPanelOrder } from "../../questions/questions";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const TIME = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The radio value of Other…: no choice can have it, as the host refuses empty labels. */
const OTHER = "\u0000other";

/** A choice's row, all of it its target: on a phone 44 px for one line, the mark beside its first line. */
const CHOICE_ROW = "flex items-start gap-2.5 max-sm:py-[13px]";

/** A question's name: its header, else its text. */
const nameOf = (record: QuestionRecord): string => record.header ?? record.question;

/**
 * The questions the chat's agent asked without waiting, in the BTW panel: each open one as a card to answer when there is
 * time, then the answered and skipped ones, folded to their answer.
 */
export function QuestionsTab({ controller }: { readonly controller: ChatController }): ReactNode {
  const { records, focused } = useSyncExternalStore(
    controller.questions.subscribe,
    controller.questions.getSnapshot,
  );
  const listRef = useRef<HTMLDivElement>(null);

  // A question asked to be brought into view (the arrival notice) is scrolled to once it is drawn.
  useEffect(() => {
    if (focused === null || records === null) return;
    const card = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`);
    card?.scrollIntoView({ block: "nearest" });
    controller.questions.focused();
  }, [focused, records, controller]);

  if (records === null)
    return <p className="px-4 py-3 text-[0.8125rem] text-t3">Reading the questions…</p>;
  if (records.length === 0)
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="font-medium text-t1">No questions for you</p>
        <p className="text-[0.8125rem] text-t3">
          When omp asks you something it does not need at once, the question waits here while omp
          keeps working. Answer when you have time: your answer goes to the chat as your message.
        </p>
      </div>
    );
  const { open, answered } = inPanelOrder(records);
  return (
    <div
      ref={listRef}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-[0.8125rem]"
    >
      {open.length === 0 && (
        <p className="px-1 text-t3">Nothing waits for you. Answered questions are below.</p>
      )}
      {open.map((record) => (
        <QuestionCard key={record.id} record={record} controller={controller} />
      ))}
      {answered.length > 0 && (
        <section aria-label="Answered questions" className="flex flex-col gap-1.5">
          <h3 className="px-1 pt-1 text-xs font-medium text-t3">Answered</h3>
          {answered.map((record) => (
            <article
              key={record.id}
              data-id={record.id}
              aria-label={`Answered: ${nameOf(record)}`}
              className="flex flex-col gap-0.5 rounded-lg border border-l2 px-3 py-2"
            >
              <span className="line-clamp-2 text-t2">{record.question}</span>
              <span className="text-xs text-t3">
                {record.answer?.skipped === true ? "Skipped" : "Your answer"}
                {record.answer !== null && (
                  <span className="font-mono"> · {TIME.format(record.answer.answeredAt)}</span>
                )}
              </span>
              {record.answer?.skipped !== true && (
                <span className="break-words text-t1">{answerSummary(record)}</span>
              )}
              {record.answer?.note !== undefined && (
                <span className="break-words text-xs text-t3">Note: {record.answer.note}</span>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * One open question: its header and time, the question, the agent's context, then the answer: choices (round marks for
 * one, tick boxes for several) with Other… to write one's own, or a box to write the answer in when there are no
 * choices; a note may go with it. Send answer sends it to the chat as the person's message; Skip tells the agent to
 * decide.
 */
function QuestionCard({
  record,
  controller,
}: {
  readonly record: QuestionRecord;
  readonly controller: ChatController;
}): ReactNode {
  const [picked, setPicked] = useState<readonly string[]>([]);
  /** The written answer: Other…'s, or the whole answer when there are no choices; undefined while Other… is off. */
  const [typed, setTyped] = useState<string | undefined>(
    record.options.length === 0 ? "" : undefined,
  );
  const [note, setNote] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState<"answer" | "skip" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const writtenId = useId();
  const choices = record.options.length > 0;
  const ready = picked.length > 0 || (typed ?? "").trim() !== "";

  const send = (): void => {
    if (!ready || sending !== null) return;
    setSending("answer");
    setProblem(null);
    const written = typed?.trim();
    const noted = note?.trim();
    controller
      .answerQuestion(record.id, {
        picked: [...picked],
        ...(written ? { typed: written } : {}),
        ...(noted ? { note: noted } : {}),
      })
      .catch((failure: unknown) => setProblem(`Not sent: ${failureText(failure)}`))
      .finally(() => setSending(null));
  };

  const skip = (): void => {
    if (sending !== null) return;
    setSending("skip");
    setProblem(null);
    controller
      .skipQuestion(record.id)
      .catch((failure: unknown) => setProblem(`Not skipped: ${failureText(failure)}`))
      .finally(() => setSending(null));
  };

  const enterSends = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !isImeEnter(event)) {
      event.preventDefault();
      send();
    }
  };

  const otherOn = typed !== undefined;
  const otherRow = (
    <span className="flex min-w-0 flex-col">
      <span className="text-t1">Other…</span>
      <span className="text-xs text-t3">Write your own answer</span>
    </span>
  );
  return (
    <article
      data-id={record.id}
      aria-label={`Question: ${nameOf(record)}`}
      className="flex flex-col gap-2.5 rounded-xl border border-l3 bg-card p-3 shadow-sm"
    >
      <header className="flex items-center gap-2 text-xs text-t3">
        {record.header !== undefined && (
          <span className="rounded-sm bg-l2 px-1.5 py-0.5 text-accent-ink">{record.header}</span>
        )}
        <span className="font-mono">Asked {TIME.format(record.askedAt)}</span>
      </header>
      <div className="text-t1">
        <Markdown text={record.question} />
      </div>
      {record.context !== undefined && (
        <section
          aria-label="Context"
          className="rounded-lg border border-l2 bg-l1 px-3 py-2 text-xs text-t2"
        >
          <Markdown text={record.context} />
        </section>
      )}
      {!choices ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={writtenId} className="text-xs font-medium text-t2">
            Your answer
          </label>
          <Textarea
            id={writtenId}
            rows={2}
            value={typed ?? ""}
            placeholder="Write your answer"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={enterSends}
          />
        </div>
      ) : record.multi ? (
        <fieldset className="flex min-w-0 flex-col gap-2 max-sm:gap-0" aria-label={record.question}>
          {record.options.map((option, at) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control
            <label key={option.label} className={CHOICE_ROW}>
              <Checkbox
                className="mt-0.5"
                aria-label={option.label}
                checked={picked.includes(option.label)}
                onCheckedChange={(checked) =>
                  setPicked((now) =>
                    checked === true
                      ? [...now, option.label]
                      : now.filter((label) => label !== option.label),
                  )
                }
              />
              <OptionText
                label={option.label}
                description={option.description}
                recommended={record.recommended === at}
              />
            </label>
          ))}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control */}
          <label className={CHOICE_ROW}>
            <Checkbox
              className="mt-0.5"
              aria-label="Other…"
              checked={otherOn}
              onCheckedChange={(checked) => setTyped(checked === true ? "" : undefined)}
            />
            {otherRow}
          </label>
        </fieldset>
      ) : (
        <RadioGroup
          className="max-sm:gap-0"
          aria-label={record.question}
          value={otherOn ? OTHER : (picked[0] ?? null)}
          onValueChange={(value) => {
            if (value === OTHER) {
              setPicked([]);
              setTyped("");
            } else if (typeof value === "string") {
              setPicked([value]);
              setTyped(undefined);
            }
          }}
        >
          {record.options.map((option, at) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
            <label key={option.label} className={CHOICE_ROW}>
              <RadioGroupItem className="mt-0.5" value={option.label} aria-label={option.label} />
              <OptionText
                label={option.label}
                description={option.description}
                recommended={record.recommended === at}
              />
            </label>
          ))}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className={CHOICE_ROW}>
            <RadioGroupItem className="mt-0.5" value={OTHER} aria-label="Other…" />
            {otherRow}
          </label>
        </RadioGroup>
      )}
      {choices && otherOn && (
        <Input
          aria-label={`Your own answer: ${record.question}`}
          placeholder="Write your own answer"
          value={typed ?? ""}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={enterSends}
        />
      )}
      {note !== undefined && (
        <Textarea
          aria-label="Note on your answer"
          placeholder="A note omp gets with your answer"
          className="min-h-16"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-2">
        {note === undefined && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setNote("")}>
            Add a note
          </Button>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={sending !== null}
          onClick={skip}
        >
          {sending === "skip" ? "Skipping…" : "Skip"}
        </Button>
        <Button type="button" size="sm" disabled={!ready || sending !== null} onClick={send}>
          {sending === "answer" ? "Sending…" : "Send answer"}
        </Button>
      </footer>
    </article>
  );
}
