import { ArrowUp, Brain, Square } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerMenu } from "./ComposerMenu";
import type { ChatController } from "./controller";
import { ModelPicker } from "./ModelPicker";
import { QueuedMessages } from "./QueuedMessages";
import type { ChatActivity, ChatModel, ChatQueue } from "./store";
import { shellRun } from "./triggers";
import { useComposerMenu } from "./useComposerMenu";
import { WorkingRow } from "./WorkingRow";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Text that came back from omp's queue, put in front of what the box holds. */
const withRestored = (restored: readonly string[], current: string): string =>
  [...restored, current].filter((part) => part.trim() !== "").join("\n\n");

/**
 * The message box: Enter sends; while omp works, Enter steers and Ctrl+Enter queues a follow-up; Shift+Enter or
 * Alt+Enter adds a line; Esc stops omp and brings queued messages back into the box. `/` at the start lists omp's
 * commands and `@` lists the folder's files; `!` and `$` run bash and Python (doubled, out of the model's context). The
 * text is kept as it is typed (`drafts.ts`), and only the text that was sent leaves the box.
 */
export const Composer = memo(function Composer({
  controller,
  working,
  disabled,
  model,
  thinkingLevel,
  queue,
  activity,
  modelPickerOpen,
  onModelPickerOpenChange,
}: {
  readonly controller: ChatController;
  readonly working: boolean;
  readonly disabled: boolean;
  readonly model: ChatModel | null;
  readonly thinkingLevel: string | null;
  readonly queue: ChatQueue;
  readonly activity: ChatActivity | null;
  readonly modelPickerOpen: boolean;
  readonly onModelPickerOpenChange: (open: boolean) => void;
}): ReactNode {
  const [text, setText] = useState("");
  const textRef = useRef(text);
  const [caret, setCaret] = useState(0);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = controller.draft;
  const menu = useComposerMenu(controller, text, caret);
  const shell = shellRun(text);

  const update = (next: string): void => {
    textRef.current = next;
    setText(next);
    draft?.change(next);
  };

  // The kept text comes back when the chat opens, unless something was typed first.
  useEffect(() => {
    if (draft === null) return;
    let active = true;
    void draft.load().then((kept) => {
      if (!active || kept === "" || textRef.current !== "") return;
      textRef.current = kept;
      setText(kept);
    });
    return () => {
      active = false;
    };
  }, [draft]);

  const send = (mode: "auto" | "followUp"): void => {
    const sent = textRef.current;
    const value = sent.trim();
    if (value.length === 0 || disabled || sending) return;
    const run = shellRun(value);
    if (run !== null && run.input === "") return;
    setSending(true);
    setError(null);
    (run === null ? controller.send(value, mode) : controller.runShell(run))
      .then(() => {
        // Only what was sent leaves the box; anything typed since stays.
        const now = textRef.current;
        update(now === sent ? "" : now.startsWith(sent) ? now.slice(sent.length).trimStart() : now);
      })
      .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`))
      .finally(() => setSending(false));
  };

  const stop = (): void => {
    controller
      .stop()
      .then((restored) => {
        if (restored.length > 0) update(withRestored(restored, textRef.current));
      })
      .catch((failure: unknown) => setError(`Could not stop: ${errorText(failure)}`));
  };

  const takeBack = (message: string, queueName: "steering" | "followUp"): void => {
    controller
      .takeQueued(message, queueName)
      .then((taken) => {
        if (taken === null) return;
        update(withRestored([taken], textRef.current));
        boxRef.current?.focus();
      })
      .catch((failure: unknown) => setError(`Could not take it back: ${errorText(failure)}`));
  };

  /** Puts the menu's row into the text, and the caret after it. */
  const take = (index: number): void => {
    const next = menu.pick(index);
    if (next === null) return;
    update(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => boxRef.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (menu.menu !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        menu.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      const takes = (event.key === "Enter" || event.key === "Tab") && !event.shiftKey;
      if (takes && menu.menu.items.length > 0) {
        event.preventDefault();
        take(menu.menu.active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        menu.dismiss();
        return;
      }
    }
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stop();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    send(event.ctrlKey || event.metaKey ? "followUp" : "auto");
  };

  return (
    <div className="px-4 pt-2 pb-4">
      <div className="mx-auto max-w-[720px]">
        {activity !== null && <WorkingRow activity={activity} />}
        <QueuedMessages queue={queue} onTakeBack={takeBack} />
        <form
          className="relative rounded-xl border border-l2 bg-card focus-within:border-l4"
          onSubmit={(event) => {
            event.preventDefault();
            send("auto");
          }}
        >
          {menu.menu !== null && (
            <ComposerMenu
              label={menu.menu.label}
              items={menu.menu.items}
              active={menu.menu.active}
              empty={menu.menu.empty}
              onPick={take}
            />
          )}
          <textarea
            ref={boxRef}
            className="block max-h-[12lh] min-h-[2lh] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[0.875rem] leading-normal text-t1 outline-none [field-sizing:content] placeholder:text-t3"
            aria-label="Message"
            placeholder={disabled ? "Opening the chat…" : "Message omp"}
            value={text}
            rows={2}
            onChange={(event) => {
              setError(null);
              update(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {shell !== null && (
              <span className="shrink-0 rounded-md bg-l2 px-2 py-0.5 font-mono text-xs text-t1">
                {shell.method}
                {shell.excludeFromContext ? " · not in context" : ""}
              </span>
            )}
            <ModelPicker
              controller={controller}
              model={model}
              disabled={disabled}
              open={modelPickerOpen}
              onOpenChange={onModelPickerOpenChange}
              onError={(failure) => setError(`Could not change it: ${errorText(failure)}`)}
            />
            {thinkingLevel !== null && (
              <ThinkingChip
                controller={controller}
                level={thinkingLevel}
                disabled={disabled}
                onError={(failure) => setError(`Could not change it: ${errorText(failure)}`)}
              />
            )}
            <span
              className="min-w-0 flex-1 truncate px-1 text-right text-xs text-bad-ink"
              role="status"
            >
              {error}
            </span>
            {working ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      aria-label="Stop"
                      onClick={stop}
                    />
                  }
                >
                  <Square className="fill-current" />
                </TooltipTrigger>
                <TooltipContent>Stop (Esc)</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="submit"
                      size="icon-sm"
                      aria-label="Send"
                      disabled={disabled || sending || text.trim().length === 0}
                    />
                  }
                >
                  <ArrowUp />
                </TooltipTrigger>
                <TooltipContent>Send (Enter)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </form>
      </div>
    </div>
  );
});

/** omp's thinking level for the model; a click moves to the next level omp offers. */
function ThinkingChip({
  controller,
  level,
  disabled,
  onError,
}: {
  readonly controller: ChatController;
  readonly level: string;
  readonly disabled: boolean;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-t2 hover:text-t1"
            aria-label={`Thinking: ${level}`}
            disabled={disabled}
            onClick={() => void controller.cycleThinking().catch(onError)}
          />
        }
      >
        <Brain />
        {level}
      </TooltipTrigger>
      <TooltipContent>Thinking level. Click for the next one.</TooltipContent>
    </Tooltip>
  );
}
