import { type SentFile, splitAttached, splitHostContext, withAttached } from "@omp-app/contracts";
import type {
  ChatHostImage,
  ChatHostState,
  GoalAnswer,
  PlanModeStatus,
} from "@omp-app/contracts/chat-host";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentsPill } from "../agents/AgentsPill";
import { btwQuestion } from "../btw/btw";
import {
  desktopBridge,
  readDesktopClipboardFiles,
  readDesktopClipboardPicture,
} from "../desktop/bridge";
import { GoalChip } from "../goal/GoalChip";
import { isImeEnter } from "../keys/ime";
import { EmbedContextChip } from "../lite/EmbedContextChip";
import { LiteContext } from "../lite/LiteContext";
import { sizeText } from "../panels/files/transfer";
import { showPanel } from "../panels/panel-state";
import { usePhone } from "../phone";
import { PlanChip } from "../plan/PlanChip";
import { TodoPill } from "../todos/TodoPill";
import { type AttachedFile, MAX_FILE_BYTES, pastesCopiedFiles } from "./attachedFiles";
import { type Attachment, readImages } from "./attachments";
import type { ComposerRestore } from "./ChatPane";
import { ComposerMenu } from "./ComposerMenu";
import { caretOnEdgeRow } from "./caretRow";
import type { ChatController } from "./controller";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { ModelPicker } from "./ModelPicker";
import { PausedRow } from "./PausedRow";
import { PlusMenu } from "./PlusMenu";
import { QueuedMessages } from "./QueuedMessages";
import { QuickPanel } from "./QuickPanel";
import { QuickPromptsKey } from "./QuickPromptsKey";
import { RoleTrack } from "./RoleTrack";
import { withRestored } from "./restored";
import type {
  ChatActivity,
  ChatModel,
  ChatQueue,
  ChatSnapshot,
  ChatToast,
  ExtensionWidget,
  SentMessage,
  RoleTrack as Track,
} from "./store";
import { ThinkingMenu } from "./ThinkingMenu";
import { Toast } from "./Toast";
import { shellRun } from "./triggers";
import { holdReason } from "./usagePause";
import { useComposerMenu } from "./useComposerMenu";
import { WorkingRow, WorkingRowSpace } from "./WorkingRow";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const MB = 1024 * 1024;

/** Why a file larger than the server takes is not attached. */
const tooLargeText = (name: string, size: number): string =>
  `${name} is not attached: a file can be up to ${MAX_FILE_BYTES / MB} MB, and this one is ${(size / MB).toFixed(1)} MB.`;

/** Puts text at the box's caret as a paste does, so that it can be undone. */
function insertText(box: HTMLTextAreaElement, text: string): boolean {
  box.focus();
  return document.execCommand("insertText", false, text);
}

/** A typed `/pause` (omp's takes no arguments and ignores any). */
const PAUSE_TEXT = /^\/pause(?:\s|$)/;

/** What the palette, and the lite view's suggestions, can do with a pane's message box. */
export interface ComposerHandle {
  /** Puts text at the caret (over a selection), then the caret after it. */
  readonly insert: (text: string) => void;
  /**
   * A suggestion picked (the lite view's empty chat, #2845): with nothing in the box it is sent as the message, as Enter
   * sends it (a chat still opening sends it once open); with something typed it goes in at the caret, and what was
   * typed stays.
   */
  readonly suggest: (text: string) => void;
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
 * Files pasted, dropped or picked with the paperclip go with the next message: pictures to the model, any other file
 * uploaded to the chat's own folder and named in the message (#2830). The text is kept as it is typed (`drafts.ts`), and
 * only the text that was sent leaves the box. On a phone the return key adds a line, and the button sends (or, while omp
 * works, queues what is typed); ＋ holds the box's settings (`PlusMenu`) and ⚡ beside Send the quick prompts
 * (`QuickPromptsKey`). Nothing comes up between the box and the phone's keyboard: the keyboard has `/`, `@` and `!`.
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
  roles,
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
  widgets,
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
  /** The roles Ctrl+P switches between, each with its model: the model menu lists them. */
  readonly roles: ChatSnapshot["roles"];
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
  /** The lines extensions show beside the box (omp's widgets, #2842), above or below it. */
  readonly widgets: readonly ExtensionWidget[];
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
  /** Files for the next message other than pictures: uploaded to the chat's own folder as they are attached (#2830). */
  const [files, setFiles] = useState<readonly AttachedFile[]>([]);
  const filesRef = useRef(files);
  /** The uploads still running, by file: taking a file out of the box cancels its upload. */
  const uploads = useRef(new Map<string, AbortController>());
  const [dragging, setDragging] = useState(false);
  /** Whether the phone's quick panel is open, in the keyboard's place. */
  const [panel, setPanel] = useState(false);
  const phone = usePhone();
  /** The lite view's choices (#2845): the framing app's placeholder; null in the full app. */
  const lite = use(LiteContext);
  /** Whether the phone's ＋ sheet is open (`PlusMenu`). */
  const [plusOpen, setPlusOpen] = useState(false);
  // On a phone the model chip is in the ＋ sheet: what opens the model menu (a failed request's "Switch model") opens
  // the sheet too, so the menu has its chip.
  useEffect(() => {
    if (phone && modelPickerOpen) setPlusOpen(true);
  }, [phone, modelPickerOpen]);
  // Paused by its usage pause (#2781 part 3): the paused row says at which limit and when the chat goes on.
  const pauseReason = useSyncExternalStore(controller.store.subscribe, () => {
    const usagePause = controller.store.getSnapshot().usagePause;
    return usagePause?.hold == null ? undefined : holdReason(usagePause.percent, usagePause.hold);
  });
  const draft = controller.draft;
  const menu = useComposerMenu(controller, text, caret);
  const shell = shellRun(text);
  /** Where Up and Down are in the history, and what the box held before; null while not going through it. */
  const browsing = useRef<{ readonly index: number; readonly kept: string } | null>(null);
  const insertRef = useRef<(inserted: string) => void>(() => undefined);
  const suggestRef = useRef<(text: string) => void>(() => undefined);
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
    onHandle({
      insert: (inserted) => insertRef.current(inserted),
      suggest: (text) => suggestRef.current(text),
    });
    return () => onHandle(null);
  }, [onHandle]);
  // Text asked into this chat from elsewhere (the Files panel's Mention in chat) goes in at the caret, as `@` does.
  useEffect(() => controller.onInsertText((inserted) => insertRef.current(inserted)), [controller]);

  const attach = (next: readonly Attachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const attachFiles = (next: readonly AttachedFile[]): void => {
    filesRef.current = next;
    setFiles(next);
  };
  const patchFile = (id: string, patch: Partial<AttachedFile>): void =>
    attachFiles(filesRef.current.map((file) => (file.id === id ? { ...file, ...patch } : file)));

  /** Uploads a file to the chat's folder; its chip shows how far it got, then its size. */
  const upload = (file: File): void => {
    const shown = file.name === "" ? "The pasted file" : file.name;
    if (file.size > MAX_FILE_BYTES) {
      setError(tooLargeText(shown, file.size));
      return;
    }
    const id = crypto.randomUUID();
    const abort = new AbortController();
    uploads.current.set(id, abort);
    attachFiles([
      ...filesRef.current,
      {
        id,
        name: file.name === "" ? "file" : file.name,
        size: sizeText(file.size),
        progress: 0,
        own: true,
      },
    ]);
    controller
      .uploadAttachment(file, {
        // The names of the box's other files, read as this one's name is chosen.
        reserved: () =>
          new Set(filesRef.current.filter((held) => held.id !== id).map((held) => held.name)),
        signal: abort.signal,
        onName: (name) => patchFile(id, { name }),
        onProgress: (sent) => patchFile(id, { progress: file.size === 0 ? 1 : sent / file.size }),
      })
      .then(() => patchFile(id, { progress: null }))
      .catch((failure: unknown) => {
        attachFiles(filesRef.current.filter((held) => held.id !== id));
        if (abort.signal.aborted) return;
        // A message waiting for its files is not sent without one of them.
        setWaitingToSend(null);
        setError(`Could not upload ${shown}: ${errorText(failure)}`);
      })
      .finally(() => uploads.current.delete(id));
  };

  /** Takes a file out of the box: an upload stops, and a file this box uploaded leaves the chat's folder too. */
  const removeFile = (file: AttachedFile): void => {
    uploads.current.get(file.id)?.abort();
    attachFiles(filesRef.current.filter((held) => held.id !== file.id));
    if (file.own && file.progress === null)
      void controller.removeAttachment(file.name).catch(() => undefined);
  };

  /** Takes pasted, dropped or picked files: pictures go with the message, any other file is uploaded. */
  const addFiles = (picked: readonly File[]): void => {
    const already = attachmentsRef.current.reduce((sum, attachment) => sum + attachment.bytes, 0);
    setError(null);
    void readImages(picked, already).then(({ added, others }) => {
      if (added.length > 0) attach([...attachmentsRef.current, ...added]);
      for (const file of others) upload(file);
    });
  };
  /** Pictures read from the desktop window's clipboard so far, which names the next one. */
  const windowPastes = useRef(0);
  /**
   * A paste the desktop window's engine left without what was copied (#2833): it gives a copied picture as nothing at
   * all, and the files a file manager copied as nothing or as their paths. The window reads its clipboard: the copied
   * files, else the picture. With neither, the text it gave goes in as the paste would have put it. A desktop app too old
   * to read files reads the picture only.
   */
  const pasteFromWindow = (box: HTMLTextAreaElement, text: string): void => {
    void (async () => {
      let read: Awaited<ReturnType<typeof readDesktopClipboardFiles>> = null;
      try {
        read = await readDesktopClipboardFiles(MAX_FILE_BYTES);
      } catch (failure) {
        if (text !== "") {
          insertText(box, text);
          setError(`Could not paste the copied file: ${errorText(failure)}`);
          return;
        }
      }
      if (read !== null && (read.files.length > 0 || read.tooLarge.length > 0)) {
        if (read.files.length > 0) addFiles(read.files);
        const [large] = read.tooLarge;
        if (large !== undefined) setError(tooLargeText(large.name, large.size));
        return;
      }
      if (text !== "") {
        insertText(box, text);
        return;
      }
      try {
        const file = await readDesktopClipboardPicture(++windowPastes.current);
        if (file !== null) addFiles([file]);
      } catch (failure) {
        setError(`Could not paste the picture: ${errorText(failure)}`);
      }
    })();
  };

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

  /** Files a message names, back in the box as they are in the chat's folder: nothing is uploaded again. */
  const putBackFiles = (named: readonly SentFile[]): void => {
    const held = new Set(filesRef.current.map((file) => file.name));
    const fresh = named.filter((file) => !held.has(file.name));
    if (fresh.length === 0) return;
    attachFiles([
      ...filesRef.current,
      ...fresh.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        progress: null,
        own: false,
      })),
    ]);
  };

  /**
   * Messages that came back to the box (Edit, Stop's queue, a queued message taken back, a message Stop dropped): their
   * text joins what the box holds, and their pictures and files come back as attachments, not as text.
   */
  const restoreMessages = (
    messages: readonly { readonly text: string; readonly images?: readonly ChatHostImage[] }[],
  ): void => {
    // What was open in the app that embeds the panel goes again with the next message: only what was typed comes back.
    const parts = messages.map((message) => splitAttached(splitHostContext(message.text).text));
    update(
      withRestored(
        parts.map((part) => part.text),
        textRef.current,
      ),
    );
    putBack(messages.flatMap((message) => message.images ?? []));
    putBackFiles(parts.flatMap((part) => part.files));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: an edited message is put in once, when Edit brings it
  useEffect(() => {
    if (restore === null) return;
    restoreMessages([restore]);
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
    const attachedFiles = filesRef.current;
    if ((value.length === 0 && images.length === 0 && attachedFiles.length === 0) || sending)
      return;
    // A chat still opening, or a file still uploading: the message goes once they are done.
    if (disabled || attachedFiles.some((file) => file.progress !== null)) {
      if (!closed) setWaitingToSend(mode);
      return;
    }
    setWaitingToSend(null);
    if (working) setJustQueued(true);
    // omp's `/btw`: a side question, answered beside the chat on the Questions panel's Side questions tab; `/btw` alone
    // opens that tab.
    const aside = btwQuestion(value);
    if (aside !== null) {
      if (aside === "") {
        update("");
        controller.btw.reveal();
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
          controller.btw.reveal(record.id);
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
    // The files go as a paragraph after the text that names each by its `local://` address (#2830).
    const message = withAttached(value, attachedFiles);
    (run === null
      ? controller.send(
          message,
          mode,
          images.map((attachment) => attachment.image),
        )
      : controller.runShell(run)
    )
      .then(() => {
        // Held at omp's pause, the message is not in the chat yet: the paused row says it waits.
        if (run === null && pausedAt !== null) controller.store.holdMessage(message);
        // Only what was sent leaves the box; anything typed or attached since stays.
        const now = textRef.current;
        update(now === sent ? "" : now.startsWith(sent) ? now.slice(sent.length).trimStart() : now);
        if (run === null) {
          const gone = new Set(images.map((attachment) => attachment.id));
          attach(attachmentsRef.current.filter((attachment) => !gone.has(attachment.id)));
          const goneFiles = new Set(attachedFiles.map((file) => file.id));
          attachFiles(filesRef.current.filter((file) => !goneFiles.has(file.id)));
        }
      })
      .catch((failure: unknown) => setError(`Not sent: ${errorText(failure)}`))
      .finally(() => setSending(false));
  };
  suggestRef.current = (suggestion) => {
    const typed =
      textRef.current.trim() !== "" ||
      attachmentsRef.current.length > 0 ||
      filesRef.current.length > 0;
    if (typed) {
      insertRef.current(suggestion);
      return;
    }
    update(suggestion);
    send("auto");
  };

  /** A file of the box still uploading: a message sent meanwhile waits for it. */
  const uploading = files.some((file) => file.progress !== null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends once, when the chat is ready and the files are up
  useEffect(() => {
    if (!disabled && !uploading && waitingToSend !== null) send(waitingToSend);
  }, [disabled, uploading]);

  const stop = (): void => {
    controller
      .stop()
      .then((restored) => {
        if (restored.length > 0) restoreMessages(restored);
      })
      .catch((failure: unknown) => setError(`Could not stop: ${errorText(failure)}`));
  };

  const takeBack = (message: string, queueName: "steering" | "followUp"): void => {
    controller
      .takeQueued(message, queueName)
      .then((taken) => {
        if (taken === null) return;
        restoreMessages([taken]);
        boxRef.current?.focus();
      })
      .catch((failure: unknown) => setError(`Could not take it back: ${errorText(failure)}`));
  };

  // A message whose turn never started because Stop came first comes back to the box, as Stop's queue does.
  const sendDroppedRef = useRef<(sent: SentMessage) => void>(() => undefined);
  sendDroppedRef.current = (sent) => restoreMessages([sent]);
  useEffect(
    () => controller.store.onSendDropped((sent) => sendDroppedRef.current(sent)),
    [controller],
  );

  /** Puts the box a menu row leaves into the box, and the caret after the row's text. */
  const put = (next: { readonly text: string; readonly caret: number }): void => {
    update(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => boxRef.current?.setSelectionRange(next.caret, next.caret));
  };

  /**
   * Puts the menu's row into the text. A row of a mention with spaces whose answer is still coming is put in once the
   * answer still has it, and only if the box was not changed meanwhile (#2846).
   */
  const take = (index: number): void => {
    const next = menu.pick(index);
    if (next === null) return;
    if (next instanceof Promise) {
      const typed = textRef.current;
      void next.then((later) => {
        if (later !== null && textRef.current === typed) put(later);
      });
      return;
    }
    put(next);
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

  /** omp's `!` or `$` mode while the text starts with one: with the settings on a desktop, above the text on a phone. */
  const shellBadge = shell !== null && (
    <span
      data-tour="shell-mode"
      className="min-w-0 truncate rounded-md bg-l2 px-2 py-0.5 font-mono text-xs text-t1"
    >
      {shell.method}
      {shell.excludeFromContext ? " · not in context" : ""}
    </span>
  );
  /** The box's settings: on a desktop under the text, on a phone in the ＋ sheet (`PlusMenu`). */
  const settings = (
    <>
      <ModelPicker
        controller={controller}
        model={model}
        role={role}
        roles={roles}
        disabled={disabled}
        open={modelPickerOpen}
        onOpenChange={onModelPickerOpenChange}
        onError={(failure) => setError(`Could not change it: ${errorText(failure)}`)}
      />
      {thinkingLevel !== null && (
        <ThinkingMenu
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
    error ??
    (waitingToSend === null
      ? null
      : disabled
        ? "Sends once the chat is open"
        : uploading
          ? "Sends once the files are uploaded"
          : null);
  /**
   * Files from the device's own picker, on every device (#2783, #2830): any kind, as dropping or pasting takes. On an
   * iPhone the picker offers the photo library, the camera and Files; a photo comes as JPEG (Safari converts HEIC). A
   * computer has its button under the text; a phone has it in the ＋ sheet (`PlusMenu`).
   */
  const pickerInput = (
    <input
      ref={picker}
      type="file"
      multiple
      hidden
      aria-label="Files to attach"
      onChange={(event) => {
        const picked = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (picked.length > 0) addFiles(picked);
      }}
    />
  );
  const attachButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-t3 hover:text-t1 tablet:size-11"
            aria-label="Attach files"
            data-tour="attach-files"
            disabled={closed}
            onClick={() => picker.current?.click()}
          >
            <Paperclip />
          </Button>
        }
      />
      <TooltipContent>Attach files, or drop them on the box</TooltipContent>
    </Tooltip>
  );
  /**
   * The framing app's text in the lite view (#2845). On a phone the model and its level are behind ＋: the empty box
   * names them ("Claude Opus 5.5 · high"), on one line beside ⚡ and Send.
   */
  const readyPlaceholder =
    lite?.placeholder ??
    (phone && model !== null
      ? `${model.name.length > 24 ? `${model.name.slice(0, 23)}…` : model.name}${
          thinkingLevel !== null && thinkingLevel !== "off" ? ` · ${thinkingLevel}` : ""
        }`
      : "Message omp");
  /** Something to send: text, pictures or files. */
  const typed = text.trim().length > 0 || attachments.length > 0 || files.length > 0;
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
    <div className="composer-foot px-4 pt-2 pb-4 max-sm:px-2">
      <div className="relative mx-auto max-w-[720px]">
        {toast !== null && <Toast toast={toast} onDone={onToastDone} />}
        {/* On a phone the pills live in the top bar (`PhoneDetailsButton`): no row of their own above the box. */}
        {pausedAt !== null ? (
          <PausedRow
            pausedAt={pausedAt}
            held={held}
            {...(pauseReason === undefined ? {} : { reason: pauseReason })}
            onResume={resume}
            resumeKey={!phone}
          />
        ) : activity !== null ? (
          <WorkingRow activity={activity} stopKey={!phone} {...(phone ? {} : { onPause: pause })} />
        ) : (
          // On a computer the line keeps its room while nothing runs, so the chat does not move when a turn starts or ends.
          !phone && <WorkingRowSpace />
        )}
        {roleTrack !== null && <RoleTrack track={roleTrack} onDone={onRoleTrackDone} />}
        <QueuedMessages queue={queue} onTakeBack={takeBack} />
        {hasPills && !phone && (
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
        {lite !== null && <EmbedContextChip />}
        <ExtensionWidgets widgets={widgets} placement="aboveEditor" />
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
          {(attachments.length > 0 || files.length > 0) && (
            // A phone keeps them on one row that scrolls sideways: the box stays low.
            <ul
              aria-label="Attachments"
              className="flex flex-wrap gap-2 px-3 pt-3 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-2 max-sm:pt-2 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden"
            >
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-l2 bg-raise p-1 max-sm:py-0"
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
              {files.map((file) => (
                <li
                  key={file.id}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-l2 bg-raise p-1 max-sm:py-0"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-secondary text-t2">
                    <FileText className="size-4" />
                  </span>
                  <span className="max-w-40 truncate text-xs text-t2">{file.name}</span>
                  <span className="text-xs text-t3 tabular-nums">
                    {file.progress === null ? file.size : `${Math.floor(file.progress * 100)}%`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-t3 hover:text-t1"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(file)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {pickerInput}
          {phone && shellBadge !== false && <div className="flex px-3 pt-2">{shellBadge}</div>}
          {/* ＋, the text, ⚡ and Send are a finger's 44 pt each: an even inset keeps them centred, the box no taller. */}
          <div className={phone ? "flex items-end gap-1.5 p-[3px]" : undefined}>
            {phone && (
              <PlusMenu
                open={plusOpen}
                onOpenChange={setPlusOpen}
                settings={settings}
                closed={closed}
                onAttach={() => picker.current?.click()}
                onQuickPrompts={() => {
                  setPanel(true);
                  boxRef.current?.blur();
                }}
                {...(working || pausedAt !== null
                  ? {
                      pause: {
                        paused: pausedAt !== null,
                        onPress: pausedAt !== null ? resume : pause,
                      },
                    }
                  : {})}
              />
            )}
            <textarea
              ref={boxRef}
              className={`block w-full resize-none bg-transparent px-3.5 text-t1 outline-none [field-sizing:content] placeholder:text-t3 ${phone ? "max-h-[6lh] min-h-[1lh] min-w-0 py-[11px] text-[length:var(--host-text-size,1rem)] leading-snug placeholder:truncate" : "max-h-[12lh] min-h-[2lh] pt-3 pb-1 text-[length:var(--host-text-size,0.875rem)] leading-normal"}`}
              aria-label="Message"
              placeholder={
                closed
                  ? "This chat could not be opened"
                  : disabled
                    ? "Opening the chat…"
                    : readyPlaceholder
              }
              value={text}
              rows={phone ? 1 : 2}
              // The keyboard takes the quick panel's place.
              onFocus={() => setPanel(false)}
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
                const data = event.clipboardData;
                const files = [...data.files];
                const text = data.getData("text/plain");
                // A file manager's copy: its files' addresses, and their paths as text (#2833). Text copied from a page
                // or a program goes in as text, as before, also when a picture of it comes along (a spreadsheet's).
                const copied = pastesCopiedFiles(data.getData("text/uri-list"), text);
                if (files.length > 0 && (text === "" || copied)) {
                  event.preventDefault();
                  addFiles(files);
                  return;
                }
                if (desktopBridge() === null || (text !== "" && !copied)) return;
                event.preventDefault();
                pasteFromWindow(event.currentTarget, text);
              }}
            />
            {phone && (
              <QuickPromptsKey
                open={panel}
                onPress={() => {
                  if (panel) {
                    setPanel(false);
                    // Within the tap, so the keyboard comes back up.
                    boxRef.current?.focus({ preventScroll: true });
                  } else {
                    setPanel(true);
                    boxRef.current?.blur();
                  }
                }}
              />
            )}
            {phone && sendOrStop}
          </div>
          {!phone && (
            // One row at any width, Send at its end (#2845's narrow side panels): the row is a container, so when it
            // is short of room the model's name shortens, and below 22rem the thinking level and Plan show only
            // their icons (`ThinkingMenu`, `PlanChip`).
            <div className="@container flex min-w-0 items-center gap-1 px-2 pb-2">
              {attachButton}
              {shellBadge}
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
        <ExtensionWidgets widgets={widgets} placement="belowEditor" />
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
