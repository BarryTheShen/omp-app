import type {
  ChatHostImage,
  ChatHostState,
  GoalAnswer,
  PlanModeStatus,
} from "@omp-app/contracts/chat-host";
import { ArrowUp, Brain, ImagePlus, Square, X } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentsPill } from "../agents/AgentsPill";
import { btwQuestion } from "../btw/btw";
import { desktopBridge, readDesktopClipboardPicture } from "../desktop/bridge";
import { GoalChip } from "../goal/GoalChip";
import { isImeEnter } from "../keys/ime";
import { showPanel } from "../panels/panel-state";
import { isTablet, usePhone } from "../phone";
import { PlanChip } from "../plan/PlanChip";
import { TodoPill } from "../todos/TodoPill";
import { type Attachment, IMAGE_TYPES, readImages } from "./attachments";
import type { ComposerRestore } from "./ChatPane";
import { ComposerMenu } from "./ComposerMenu";
import { caretOnEdgeRow } from "./caretRow";
import type { ChatController } from "./controller";
import { KeyRow } from "./KeyRow";
import { ModelPicker } from "./ModelPicker";
import { PausedRow } from "./PausedRow";
import { QueuedMessages } from "./QueuedMessages";
import { QuickPanel } from "./QuickPanel";
import { RoleTrack } from "./RoleTrack";
import { withRestored } from "./restored";
import type { ChatActivity, ChatModel, ChatQueue, ChatToast, RoleTrack as Track } from "./store";
import { Toast } from "./Toast";
import { shellRun } from "./triggers";
import { holdReason } from "./usagePause";
import { useComposerMenu } from "./useComposerMenu";
import { WorkingRow } from "./WorkingRow";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A typed `/pause` (omp's takes no arguments and ignores any). */
const PAUSE_TEXT = /^\/pause(?:\s|$)/;

/** What the palette can do with a pane's message box. */
export interface ComposerHandle {
  /** Puts text at the caret (over a selection), then the caret after it. */
  readonly insert: (text: string) => void;
}

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
 * that was sent leaves the box. On a phone the return key adds a line, and the button sends (or, while omp works,
 * queues what is typed); the box's settings and the keys a phone lacks are in the key row under it (`KeyRow`).
 */
export const Composer = memo(function Composer({
  controller,
  working,
  pausedAt,
  held,
  disabled,
  closed,
  model,
  role,
  roleTrack,
  onRoleTrackDone,
  toast,
  onToastDone,
  thinkingLevel,
  queue,
  activity,
  modelPickerOpen,
  onModelPickerOpenChange,
  restore,
  history,
  approval,
  onHandle,
  agentsRunning,
  agentsTotal,
  onOpenAgents,
  todos,
  planMode,
  goal,
}: {
  readonly controller: ChatController;
  readonly working: boolean;
  /** When the chat's pause began (omp's `/pause`); null while it runs. */
  readonly pausedAt: number | null;
  /** Messages sent while the chat is paused, which omp shows once it goes on. */
  readonly held: readonly string[];
  readonly disabled: boolean;
  /** The chat could not be opened: the box says so, and nothing typed waits to be sent. */
  readonly closed: boolean;
  readonly model: ChatModel | null;
  /** The role whose model the chat runs (omp's `smol`, `slow`, …); the chip names it, `default` aside. */
  readonly role: string | null;
  /** After Ctrl+P, the roles in their order for a moment; `onRoleTrackDone` ends it. */
  readonly roleTrack: Track | null;
  readonly onRoleTrackDone: (id: number) => void;
  /** omp's latest status line, as a toast above the box; `onToastDone` ends it. */
  readonly toast: ChatToast | null;
  readonly onToastDone: (id: number) => void;
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
  /** The chat's subagents: how many run, of how many; a pill above the box opens the Agent Hub. */
  readonly agentsRunning: number;
  readonly agentsTotal: number;
  readonly onOpenAgents: () => void;
  /** omp's todo list for the chat, phase by phase; a pill above the box shows it. */
  readonly todos: ChatHostState["todoPhases"];
  /** omp's plan mode (a chip turns it on and off) and the chat's goal (a chip shows it). */
  readonly planMode: PlanModeStatus | null;
  readonly goal: GoalAnswer["goal"];
}): ReactNode {
  const [text, setText] = useState("");
  const textRef = useRef(text);
  const [caret, setCaret] = useState(0);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const [dragging, setDragging] = useState(false);
  /** Whether the box has the focus: on a phone the keyboard is up then, and the key row offers to put it away. */
  const [focused, setFocused] = useState(false);
  /** Whether the phone's quick panel is open, in the keyboard's place. */
  const [panel, setPanel] = useState(false);
  const phone = usePhone();
  // Paused by its usage pause (#2781 part 3): the paused row says at which limit and when the chat goes on.
  const pauseReason = useSyncExternalStore(controller.store.subscribe, () => {
    const usagePause = controller.store.getSnapshot().usagePause;
    return usagePause?.hold == null ? undefined : holdReason(usagePause.percent, usagePause.hold);
  });
  /** A tablet: a touch screen wider than a phone, where a picture is not pasted or dropped either. */
  const touch = !phone && isTablet();
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
  // Text asked into this chat from elsewhere (the Files panel's Mention in chat) goes in at the caret, as `@` does.
  useEffect(() => controller.onInsertText((inserted) => insertRef.current(inserted)), [controller]);

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
  /** Pictures read from the desktop window's clipboard so far, which names the next one. */
  const windowPastes = useRef(0);

  const update = (next: string): void => {
    textRef.current = next;
    setText(next);
    draft.change(next);
  };

  // The kept text comes back when the chat opens, unless something was typed first.
  useEffect(() => {
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

  /**
   * Pictures of a message that came back to the box (Edit of a sent or a queued message, Stop's queue) join what it
   * holds; a picture it holds already is not put in a second time.
   */
  const putBack = (images: readonly ChatHostImage[]): void => {
    const held = new Set(attachmentsRef.current.map((attachment) => attachment.image.data));
    const fresh = images.filter((image) => !held.has(image.data));
    if (fresh.length > 0) attach([...attachmentsRef.current, ...fresh.map(asAttachment)]);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: an edited message is put in once, when Edit brings it
  useEffect(() => {
    if (restore === null) return;
    update(withRestored([restore.text], textRef.current));
    putBack(restore.images);
    boxRef.current?.focus();
  }, [restore]);

  /** Enter pressed before the chat was ready: it is sent once the chat is (a new chat takes typing at once). */
  const [waitingToSend, setWaitingToSend] = useState<"auto" | "followUp" | null>(null);
  /**
   * Just queued while omp works: for a moment the button stays Queue (unpressable, the box being empty), so a second
   * tap does not land on the Stop that takes its place and end omp's reply.
   */
  const [justQueued, setJustQueued] = useState(false);
  useEffect(() => {
    if (!justQueued) return;
    const timer = setTimeout(() => setJustQueued(false), 800);
    return () => clearTimeout(timer);
  }, [justQueued]);

  const pause = (): void => {
    setError(null);
    controller.pause().catch((failure: unknown) => setError(`Not paused: ${errorText(failure)}`));
  };
  const resume = (): void => {
    setError(null);
    controller.resume().catch((failure: unknown) => setError(`Not resumed: ${errorText(failure)}`));
  };

  const send = (mode: "auto" | "followUp"): void => {
    const sent = textRef.current;
    const value = sent.trim();
    const images = attachmentsRef.current;
    if ((value.length === 0 && images.length === 0) || sending) return;
    if (disabled) {
      if (!closed) setWaitingToSend(mode);
      return;
    }
    setWaitingToSend(null);
    if (working) setJustQueued(true);
    // omp's `/btw`: a side question, answered beside the chat in the side panel's BTW history; `/btw` alone opens it.
    const aside = btwQuestion(value);
    if (aside !== null) {
      if (aside === "") {
        update("");
        showPanel("btw");
        return;
      }
      setSending(true);
      setError(null);
      controller
        .askBtw(aside)
        .then((record) => {
          // Only what was asked leaves the box; anything typed since stays.
          const now = textRef.current;
          update(
            now === sent ? "" : now.startsWith(sent) ? now.slice(sent.length).trimStart() : now,
          );
          controller.btw.select(record.id);
          showPanel("btw");
        })
        .catch((failure: unknown) => setError(`Not asked: ${errorText(failure)}`))
        .finally(() => setSending(false));
      return;
    }
    // omp's `/pause`, caught here, so a chat that works does not get it as a steer.
    if (PAUSE_TEXT.test(value)) {
      update("");
      pause();
      return;
    }
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
        // Held at omp's pause, the message is not in the chat yet: the paused row says it waits.
        if (run === null && pausedAt !== null) controller.store.holdMessage(value);
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
        if (restored.length === 0) return;
        update(
          withRestored(
            restored.map((message) => message.text),
            textRef.current,
          ),
        );
        putBack(restored.flatMap((message) => message.images ?? []));
      })
      .catch((failure: unknown) => setError(`Could not stop: ${errorText(failure)}`));
  };

  const takeBack = (message: string, queueName: "steering" | "followUp"): void => {
    controller
      .takeQueued(message, queueName)
      .then((taken) => {
        if (taken === null) return;
        update(withRestored([taken.text], textRef.current));
        putBack(taken.images ?? []);
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

  /**
   * Up on the first row the box draws goes back through what was sent, Down on the last row forward, back to what was
   * typed. A long line wraps over several rows: the arrows move through them first.
   */
  const browse = (step: 1 | -1, box: HTMLTextAreaElement): boolean => {
    const value = textRef.current;
    if (box.selectionStart !== box.selectionEnd) return false;
    if (!caretOnEdgeRow(box, step < 0 ? "first" : "last")) return false;
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
    if (event.nativeEvent.isComposing || isImeEnter(event)) return;
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
    // Paused: Esc, Enter or Space in an empty box resume, as on omp's pause screen.
    const resumes = event.key === "Escape" || event.key === "Enter" || event.key === " ";
    if (pausedAt !== null && resumes && textRef.current === "" && !modified && !event.altKey) {
      event.preventDefault();
      resume();
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
    // A phone's keyboard has no Ctrl or Shift for a new line: its return key adds one, and the Send button sends.
    if (phone && !modified) return;
    event.preventDefault();
    send(modified ? "followUp" : "auto");
  };

  /** The box's settings: on a desktop under the text, on a phone in the key row above the keyboard. */
  const settings = (
    <>
      {shell !== null && (
        <span
          data-tour="shell-mode"
          className="min-w-0 truncate rounded-md bg-l2 px-2 py-0.5 font-mono text-xs text-t1 max-sm:flex max-sm:min-h-11 max-sm:items-center"
        >
          {shell.method}
          {shell.excludeFromContext ? " · not in context" : ""}
        </span>
      )}
      <ModelPicker
        controller={controller}
        model={model}
        role={role}
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
      <PlanChip
        controller={controller}
        status={planMode}
        disabled={disabled}
        onError={(failure) => setError(`Plan mode: ${errorText(failure)}`)}
      />
      <GoalChip controller={controller} goal={goal} />
    </>
  );
  const status =
    error ?? (waitingToSend !== null && disabled ? "Sends once the chat is open" : null);
  /**
   * Pictures from the device's own picker (#2783): where pasting and dropping a picture are out of reach, a phone or a
   * tablet. A photo picked on an iPhone comes as JPEG: Safari converts HEIC to a type the picker accepts.
   */
  const attachButton = (phone || touch) && (
    <>
      <Button
        type="button"
        variant="ghost"
        size={phone ? "icon" : "icon-sm"}
        className={phone ? "size-11 shrink-0 text-t2" : "text-t3 hover:text-t1 tablet:size-11"}
        aria-label="Attach images"
        data-tour="attach-images"
        disabled={closed}
        onClick={() => picker.current?.click()}
      >
        <ImagePlus />
      </Button>
      <input
        ref={picker}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        multiple
        hidden
        aria-label="Images to attach"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) addFiles(files);
        }}
      />
    </>
  );
  /** Something to send: text, or pictures. */
  const typed = text.trim().length > 0 || attachments.length > 0;
  /**
   * The button beside the text, a full-size target on a phone. Send while omp is idle. While omp works: Stop for an
   * empty box, and Queue once something is typed, which hands the message to omp as Enter does (omp takes it in at once
   * or after its current step, by its Interrupt Mode) without ending the reply, so a phone, whose return key adds a
   * line, queues without stopping omp.
   */
  const sendOrStop =
    working && !typed && !justQueued ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="secondary"
              size={phone ? "icon" : "icon-sm"}
              className={phone ? "size-11 shrink-0" : "tablet:size-11"}
              aria-label="Stop"
              data-tour="send-button"
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
              variant={working ? "outline" : "default"}
              size={phone ? "icon" : "icon-sm"}
              className={`${phone ? "size-11 shrink-0" : "tablet:size-11"}${working ? " text-accent-ink" : ""}`}
              aria-label={working ? "Queue" : "Send"}
              data-tour="send-button"
              // While the chat opens, Send waits for it ("Sends once the chat is open"), as Enter does: a phone has
              // only this button to send with.
              disabled={closed || sending || !typed}
            />
          }
        >
          <ArrowUp />
        </TooltipTrigger>
        <TooltipContent>
          {working ? "Queue (Enter): omp takes it in without stopping" : "Send (Enter)"}
        </TooltipContent>
      </Tooltip>
    );
  const hasPills = agentsTotal > 0 || todos.some((phase) => phase.tasks.length > 0);
  const pills = hasPills && (
    <>
      <TodoPill phases={todos} />
      <AgentsPill running={agentsRunning} total={agentsTotal} onOpen={onOpenAgents} />
    </>
  );

  /** A quick prompt from the phone's panel, sent at once: a steer while omp works, the next message when it is idle. */
  const sendPrompt = (prompt: string): void => {
    if (disabled || sending) return;
    setSending(true);
    setError(null);
    controller
      .send(prompt, "auto", [])
      .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`))
      .finally(() => setSending(false));
  };

  return (
    <div className="px-4 pt-2 pb-4 max-sm:px-2 max-sm:pb-2">
      <div className="relative mx-auto max-w-[720px]">
        {toast !== null && <Toast toast={toast} onDone={onToastDone} />}
        {/* On a phone the pills share the working row: one line between the chat and the box. */}
        {pausedAt !== null ? (
          <PausedRow
            pausedAt={pausedAt}
            held={held}
            {...(pauseReason === undefined ? {} : { reason: pauseReason })}
            onResume={resume}
            resumeKey={!phone}
          />
        ) : (
          activity !== null && (
            <WorkingRow activity={activity} stopKey={!phone} {...(phone ? {} : { onPause: pause })}>
              {phone && pills}
            </WorkingRow>
          )
        )}
        {roleTrack !== null && <RoleTrack track={roleTrack} onDone={onRoleTrackDone} />}
        <QueuedMessages queue={queue} onTakeBack={takeBack} />
        {hasPills && !(phone && activity !== null && pausedAt === null) && (
          <div className="flex min-w-0 items-center gap-1.5 px-1 pb-2">{pills}</div>
        )}
        {/* An error has a line of its own, as wide as the box and wrapping: a cut one can't be read. */}
        {status !== null && (phone || error !== null) && (
          <p
            className={`px-1 pb-1.5 text-xs text-pretty break-words ${error === null ? "text-t2" : "text-bad-ink"}`}
            role="status"
          >
            {status}
          </p>
        )}
        <form
          data-tour="message-box"
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
              kind={menu.menu.kind}
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
          <div className={phone ? "flex items-end gap-1.5 px-1.5 pb-1.5" : undefined}>
            {phone && attachButton}
            <textarea
              ref={boxRef}
              className={`block w-full resize-none bg-transparent px-3.5 text-t1 outline-none [field-sizing:content] placeholder:text-t3 ${phone ? "max-h-[6lh] min-h-[1lh] py-[11px] text-base leading-snug" : "max-h-[12lh] min-h-[2lh] pt-3 pb-1 text-[0.875rem] leading-normal"}`}
              aria-label="Message"
              placeholder={
                closed
                  ? "This chat could not be opened"
                  : disabled
                    ? "Opening the chat…"
                    : "Message omp"
              }
              value={text}
              rows={phone ? 1 : 2}
              onFocus={() => {
                setFocused(true);
                // The keyboard takes the quick panel's place.
                setPanel(false);
              }}
              onBlur={() => setFocused(false)}
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
                // Text copied from a page goes in as text, as before.
                if (event.clipboardData.getData("text/plain") !== "") return;
                if (files.length > 0) {
                  event.preventDefault();
                  addFiles(files);
                  return;
                }
                // In the desktop window a copied picture comes as nothing at all: the window reads its clipboard.
                if (desktopBridge() === null) return;
                event.preventDefault();
                readDesktopClipboardPicture(++windowPastes.current)
                  .then((file) => {
                    if (file !== null) addFiles([file]);
                  })
                  .catch((failure: unknown) =>
                    setError(`Could not paste the picture: ${errorText(failure)}`),
                  );
              }}
            />
            {phone && sendOrStop}
          </div>
          {!phone && (
            <div className="flex items-center gap-1 px-2 pb-2">
              {attachButton}
              {settings}
              <span
                className="min-w-0 flex-1 truncate px-1 text-right text-xs text-t3"
                role="status"
              >
                {error === null ? status : null}
              </span>
              {sendOrStop}
            </div>
          )}
        </form>
        {phone && (
          <KeyRow
            settings={settings}
            keyboardUp={focused}
            panelOpen={panel}
            onPanel={() => {
              if (panel) {
                setPanel(false);
                // Within the tap, so the keyboard comes back up.
                boxRef.current?.focus({ preventScroll: true });
              } else {
                setPanel(true);
                boxRef.current?.blur();
              }
            }}
            onInsert={(character) => {
              // Within the tap, so a phone brings its keyboard up for what follows.
              boxRef.current?.focus({ preventScroll: true });
              insertRef.current(character);
            }}
            onHistory={(step) => {
              const box = boxRef.current;
              if (box === null) return;
              // The key goes through the sent messages wherever the caret is, as the arrows do from the box's edge.
              const edge = step < 0 ? 0 : box.value.length;
              box.setSelectionRange(edge, edge);
              browse(step, box);
            }}
            onHideKeyboard={() => boxRef.current?.blur()}
            {...(working || pausedAt !== null
              ? {
                  pause: { paused: pausedAt !== null, onPress: pausedAt !== null ? resume : pause },
                }
              : {})}
          />
        )}
        {phone && panel && (
          <QuickPanel
            history={history}
            disabled={disabled || sending}
            onSend={sendPrompt}
            onPut={(prompt) => {
              boxRef.current?.focus({ preventScroll: true });
              insertRef.current(prompt);
            }}
          />
        )}
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
            data-tour="thinking"
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-t2 hover:text-t1 tablet:h-11"
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
