import type { ChatHostImage } from "@omp-app/contracts/chat-host";
import { ArrowUp, Brain, Square, X } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Attachment, readImages } from "./attachments";
import type { ComposerRestore } from "./ChatPane";
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

/** What the palette can do with a pane's message box. */
export interface ComposerHandle {
  /** Puts text at the caret (over a selection), then the caret after it. */
  readonly insert: (text: string) => void;
}

/** Text that came back from omp's queue, put in front of what the box holds. */
const withRestored = (restored: readonly string[], current: string): string =>
  [...restored, current].filter((part) => part.trim() !== "").join("\n\n");

/** An image omp gave back (an edited message's), as the box holds it. */
const asAttachment = (image: ChatHostImage, index: number): Attachment => ({
  id: crypto.randomUUID(),
  name: `image ${index + 1}`,
  bytes: Math.floor((image.data.length * 3) / 4),
  image,
});

/**
 * The message box: Enter sends; while omp works, Enter steers and Ctrl+Enter queues a follow-up; Shift+Enter or
 * Alt+Enter adds a line; Esc stops omp and brings queued messages back into the box. `/` at the start lists omp's
 * commands and `@` lists the folder's files; `!` and `$` run bash and Python (doubled, out of the model's context).
 * Images pasted or dropped go with the next message. The text is kept as it is typed (`drafts.ts`), and only the text
 * that was sent leaves the box.
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
  restore,
  history,
  approval,
  onHandle,
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
  /** A message Edit brought back: its text goes in front of what the box holds, its images join the box's. */
  readonly restore: ComposerRestore | null;
  /** What was sent in this chat, oldest first, for Up and Down. */
  readonly history: readonly string[];
  /** The approval omp waits on, if any: Ctrl+Enter approves it once and Esc denies it. */
  readonly approval: string | null;
  /** Receives the box's handle, and null once the box is gone. */
  readonly onHandle?: ((handle: ComposerHandle | null) => void) | undefined;
}): ReactNode {
  const [text, setText] = useState("");
  const textRef = useRef(text);
  const [caret, setCaret] = useState(0);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const [dragging, setDragging] = useState(false);
  const draft = controller.draft;
  const menu = useComposerMenu(controller, text, caret);
  const shell = shellRun(text);
  /** Where Up and Down are in the history, and what the box held before; null while not going through it. */
  const browsing = useRef<{ readonly index: number; readonly kept: string } | null>(null);
  const insertRef = useRef<(inserted: string) => void>(() => undefined);
  insertRef.current = (inserted) => {
    const value = textRef.current;
    const box = boxRef.current;
    const start = box?.selectionStart ?? value.length;
    const end = box?.selectionEnd ?? start;
    update(value.slice(0, start) + inserted + value.slice(end));
    const after = start + inserted.length;
    setCaret(after);
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      boxRef.current?.setSelectionRange(after, after);
    });
  };
  useEffect(() => {
    if (onHandle === undefined) return;
    onHandle({ insert: (inserted) => insertRef.current(inserted) });
    return () => onHandle(null);
  }, [onHandle]);

  const attach = (next: readonly Attachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  };

  /** Reads pasted or dropped files; what is not an image omp reads, or is too big, is named in the status. */
  const addFiles = (files: readonly File[]): void => {
    const already = attachmentsRef.current.reduce((sum, attachment) => sum + attachment.bytes, 0);
    void readImages(files, already).then(({ added, refused }) => {
      if (added.length > 0) attach([...attachmentsRef.current, ...added]);
      setError(refused.length > 0 ? refused.join(" ") : null);
    });
  };

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: an edited message is put in once, when Edit brings it
  useEffect(() => {
    if (restore === null) return;
    update(withRestored([restore.text], textRef.current));
    if (restore.images.length > 0)
      attach([...attachmentsRef.current, ...restore.images.map(asAttachment)]);
    boxRef.current?.focus();
  }, [restore]);

  /** Enter pressed before the chat was ready: it is sent once the chat is (a new chat takes typing at once). */
  const [waitingToSend, setWaitingToSend] = useState<"auto" | "followUp" | null>(null);

  const send = (mode: "auto" | "followUp"): void => {
    const sent = textRef.current;
    const value = sent.trim();
    const images = attachmentsRef.current;
    if ((value.length === 0 && images.length === 0) || sending) return;
    if (disabled) {
      setWaitingToSend(mode);
      return;
    }
    setWaitingToSend(null);
    const run = shellRun(value);
    if (run !== null && run.input === "") return;
    setSending(true);
    setError(null);
    (run === null
      ? controller.send(
          value,
          mode,
          images.map((attachment) => attachment.image),
        )
      : controller.runShell(run)
    )
      .then(() => {
        // Only what was sent leaves the box; anything typed or attached since stays.
        const now = textRef.current;
        update(now === sent ? "" : now.startsWith(sent) ? now.slice(sent.length).trimStart() : now);
        if (run === null) {
          const gone = new Set(images.map((attachment) => attachment.id));
          attach(attachmentsRef.current.filter((attachment) => !gone.has(attachment.id)));
        }
      })
      .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`))
      .finally(() => setSending(false));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: sends once, when the chat becomes ready
  useEffect(() => {
    if (!disabled && waitingToSend !== null) send(waitingToSend);
  }, [disabled]);

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

  /** Up on the first line goes back through what was sent, Down on the last line forward, back to what was typed. */
  const browse = (step: 1 | -1, box: HTMLTextAreaElement): boolean => {
    const value = textRef.current;
    if (box.selectionStart !== box.selectionEnd) return false;
    const before = value.slice(0, box.selectionStart);
    if (step < 0 ? before.includes("\n") : value.slice(box.selectionStart).includes("\n"))
      return false;
    const at = browsing.current;
    if (at === null && (step > 0 || history.length === 0)) return false;
    const kept = at?.kept ?? value;
    const index = (at?.index ?? history.length) + step;
    if (index < 0) return true;
    if (index >= history.length) {
      browsing.current = null;
      update(kept);
    } else {
      browsing.current = { index, kept };
      update(history[index] as string);
    }
    requestAnimationFrame(() => {
      const end = textRef.current.length;
      boxRef.current?.setSelectionRange(end, end);
    });
    return true;
  };

  const answerApproval = (id: string, answer: "once" | "deny"): void => {
    controller
      .answer(id, answer)
      .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`));
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
    const modified = event.ctrlKey || event.metaKey;
    // An approval waits: Ctrl+Enter approves it once, Esc denies it.
    if (approval !== null && event.key === "Enter" && modified && !event.shiftKey) {
      event.preventDefault();
      answerApproval(approval, "once");
      return;
    }
    if (approval !== null && event.key === "Escape") {
      event.preventDefault();
      answerApproval(approval, "deny");
      return;
    }
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stop();
      return;
    }
    if (event.key === "Tab" && event.shiftKey && !modified && !event.altKey) {
      event.preventDefault();
      controller
        .cycleThinking()
        .catch((failure: unknown) => setError(`Could not change it: ${errorText(failure)}`));
      return;
    }
    if (event.altKey && !modified && !event.shiftKey) {
      if (event.code === "KeyP") {
        event.preventDefault();
        onModelPickerOpenChange(true);
        return;
      }
      if (event.code === "KeyR" && !working) {
        event.preventDefault();
        // omp's own `/retry`: the last failed turn, again.
        controller
          .send("/retry")
          .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const last = queue.followUp.at(-1);
        if (last !== undefined) takeBack(last, "followUp");
        else {
          const steer = queue.steering.at(-1);
          if (steer !== undefined) takeBack(steer, "steering");
        }
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !modified && !event.altKey) {
      if (!event.shiftKey && browse(event.key === "ArrowUp" ? -1 : 1, event.currentTarget)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    send(modified ? "followUp" : "auto");
  };

  return (
    <div className="px-4 pt-2 pb-4">
      <div className="mx-auto max-w-[720px]">
        {activity !== null && <WorkingRow activity={activity} />}
        <QueuedMessages queue={queue} onTakeBack={takeBack} />
        <form
          className={`relative rounded-xl border bg-card ${dragging ? "border-primary" : "border-l2 focus-within:border-l4"}`}
          onSubmit={(event) => {
            event.preventDefault();
            send("auto");
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            setDragging(false);
            addFiles([...event.dataTransfer.files]);
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
          {attachments.length > 0 && (
            <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex items-center gap-1.5 rounded-md border border-l2 bg-raise p-1"
                >
                  <img
                    src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`}
                    alt=""
                    className="size-7 rounded-sm object-cover"
                  />
                  <span className="max-w-40 truncate text-xs text-t2">{attachment.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-t3 hover:text-t1"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() =>
                      attach(attachmentsRef.current.filter((kept) => kept.id !== attachment.id))
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
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
              // Typing makes what is in the box the text, wherever Up and Down had got to.
              browsing.current = null;
              update(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              // A copied picture comes as a file; text copied from a page goes in as text, as before.
              if (files.length === 0 || event.clipboardData.getData("text/plain") !== "") return;
              event.preventDefault();
              addFiles(files);
            }}
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {shell !== null && (
              <span className="min-w-0 truncate rounded-md bg-l2 px-2 py-0.5 font-mono text-xs text-t1">
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
              className={`min-w-0 flex-1 truncate px-1 text-right text-xs ${error === null ? "text-t3" : "text-bad-ink"}`}
              role="status"
            >
              {error ?? (waitingToSend !== null && disabled ? "Sends once the chat is open" : null)}
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
                      disabled={
                        disabled ||
                        sending ||
                        (text.trim().length === 0 && attachments.length === 0)
                      }
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
