import {
  type Attachment,
  ComposerPrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import type { AppError, AttachmentRef, CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { ArrowUpIcon, PlusIcon, SquareIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { InlineError } from "@/components/blocks";
import { chordLabel, isApplePlatform } from "@/shortcuts";
import { Button } from "../../../components/ui/button";
import type { PromptDelivery, PromptIntent } from "../../R0/runtime/runtime";
import { classifyLargePaste, pastedTextName } from "../attachments";
import {
  type ComposerDraft,
  type ComposerKeyChord,
  defaultSubmitPolicy,
  type SubmitPolicy,
  type SubmitPolicyInput,
  type SubmitPolicyResult,
} from "../contract";
import {
  modeForText,
  parseComposerMode,
  shouldExitMode,
  submitModeInput,
  textForMode,
} from "../modes";
import { type ArrowGesture, arrowGestureStep, NO_ARROW_GESTURE } from "./arrow-gesture";
import { useLargePasteMenuThreshold } from "./large-paste-menu";
import { offeredFiles, refusalNotice } from "./refused-files";
import { useRemeasureOnWidthChange } from "./remeasure";

export interface ComposerSurfaceProps {
  readonly submitPrompt: (intent: PromptIntent) => Promise<void>;
  readonly cancel: () => Promise<void> | void;
  readonly policy?: SubmitPolicy;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
  /** The text box's accessible name. An edit box names itself, so it is not confused with the composer. */
  readonly inputLabel?: string;
  /**
   * While an edit box takes this composer's place, its own input, attachments and actions are hidden and the
   * footer (the edit box) is the only composer on screen. The draft stays in the runtime, so nothing is lost.
   */
  readonly replaced?: boolean;
  /**
   * Why the composer cannot send right now (the app is reconnecting). While set, Enter and Send do nothing,
   * the reason is shown, and the text stays in the composer.
   */
  readonly sendBlockedReason?: string;
  /**
   * Why a message that holds an image is not sent yet: the image is still loading, or it could not be attached. While
   * set, Enter, Ctrl+Enter and Send do nothing and the text stays in the composer. Stop keeps working.
   */
  readonly attachmentHoldReason?: string;
  readonly showAttachmentNames?: boolean;
  readonly toolbar?: ReactNode;
  /**
   * The queued messages, drawn on a row of their own under the controls, so the steer hint and Stop keep their room.
   * Hidden while an edit box takes this composer's place, like the controls.
   */
  readonly queue?: ReactNode;
  /** The app's capabilities: `submitModeInput` reads Python availability from them. Empty means none. */
  readonly capabilities?: CapabilityMap;
  readonly children?: ReactNode;
  /** Two presses of ← in the empty editor, close together: omp's gesture that opens the Agent Hub. */
  readonly onDoubleLeftArrow?: () => void;
}

function attachmentRef(attachment: Attachment): AttachmentRef {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.contentType ?? "application/octet-stream",
  };
}

function imageIntents(attachments: readonly Attachment[]): NonNullable<PromptIntent["images"]> {
  const images: Array<NonNullable<PromptIntent["images"]>[number]> = [];
  for (const attachment of attachments) {
    for (const part of attachment.content ?? []) {
      if (part.type !== "image") continue;
      const image = part.image;
      if (image.startsWith("data:")) {
        const comma = image.indexOf(",");
        const header = comma >= 0 ? image.slice(0, comma) : "";
        const data = comma >= 0 ? image.slice(comma + 1) : image;
        const mimeType = header.startsWith("data:")
          ? header.slice(5).split(";", 1)[0] || "application/octet-stream"
          : "application/octet-stream";
        images.push({ type: "image", data, mimeType });
      } else {
        images.push({ type: "image", data: image, mimeType: "image/*", url: image });
      }
    }
  }
  return images;
}

function appFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: "Composer submission failed", retryable: true },
    { cause: error },
  );
}

function hasContent(text: string, attachments: readonly Attachment[]): boolean {
  return text.length > 0 || attachments.length > 0;
}

function decisionInput(
  text: string,
  attachments: readonly Attachment[],
  isStreaming: boolean,
  keyChord: ComposerKeyChord,
): SubmitPolicyInput {
  const images = imageIntents(attachments);
  const draft: ComposerDraft = {
    text,
    images,
    attachmentRefs: attachments.map(attachmentRef),
  };
  return { isStreaming, keyChord, draft };
}

/** The chord an Enter press makes: Ctrl+Enter and Cmd+Enter are the follow-up chords. */
function enterChord(modifiers: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): ComposerKeyChord {
  if (modifiers.ctrlKey) return "ctrlEnter";
  if (modifiers.metaKey) return "metaEnter";
  return "enter";
}

function intentsForDecision(
  result: SubmitPolicyResult,
  text: string,
  attachments: readonly Attachment[],
): readonly PromptIntent[] {
  if ("split" in result) return result.split;
  const images = imageIntents(attachments);
  const attachmentRefs = attachments.map(attachmentRef);
  return [
    {
      mode: "prompt",
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      delivery: result.delivery,
    },
  ];
}

/** A paste at or above the large-paste line count, waiting for the person to choose where it goes. */
interface LargePaste {
  readonly text: string;
  readonly lineCount: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

const NO_CAPABILITIES: CapabilityMap = Object.freeze({});

/** Why a message is not sent yet while a large paste's choice is open: its text is not in the message until it is chosen. */
const PASTE_CHOICE_REASON = "Choose where the pasted text goes first. The message is not sent yet.";

/** U2's assistant-ui composer surface; all submissions go through the injected R0.3 callback. */
export function ComposerSurface({
  submitPrompt,
  cancel,
  policy = defaultSubmitPolicy,
  capabilities = NO_CAPABILITIES,
  autoFocus = true,
  disabled = false,
  inputLabel = "Message input",
  replaced = false,
  sendBlockedReason,
  attachmentHoldReason,
  showAttachmentNames = true,
  toolbar,
  queue,
  onDoubleLeftArrow,
  children,
}: ComposerSurfaceProps): ReactNode {
  const aui = useAui();
  const composer = aui.composer;
  const text = useAuiState((state) => state.composer.text);
  const attachments = useAuiState((state) => state.composer.attachments);
  const isStreaming = useAuiState((state) => state.thread.isRunning);
  const canCancel = useAuiState(
    (state) => state.thread.isRunning && state.thread.capabilities.cancel,
  );
  const accept = useAuiState((state) => state.composer.attachmentAccept);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const offers = useRef<File[]>([]);
  const composingRef = useRef(false);
  const arrowGesture = useRef<ArrowGesture>(NO_ARROW_GESTURE);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const blockedId = useId();
  // A large paste waiting for the person's choice, and a counter for the names of pasted-text chips.
  const [largePaste, setLargePaste] = useState<LargePaste | null>(null);
  const pasteCount = useRef(0);
  // What holds a send back: the connection, an image the message holds, or a large paste whose choice is open.
  // Only the connection also holds Stop back.
  const notSentReason =
    sendBlockedReason ??
    attachmentHoldReason ??
    (largePaste === null ? undefined : PASTE_CHOICE_REASON);
  useRemeasureOnWidthChange(inputRef);
  useAuiEvent("composer.attachmentAddError", (failure) => {
    setError({
      code: "invalid_args",
      message: refusalNotice(failure, accept, offers.current),
      retryable: false,
    });
  });
  useAuiEvent("composer.attachmentAdd", () => setError(null));
  useEffect(() => {
    const offer = (event: Event) => {
      const files = offeredFiles(event);
      if (files.length === 0) return;
      offers.current = files;
      // Whatever this offer did not use is dropped once its browser event has finished, so no later refusal names it.
      window.setTimeout(() => {
        if (offers.current === files) offers.current = [];
      });
    };
    const kinds = ["drop", "paste", "change"] as const;
    for (const kind of kinds) document.addEventListener(kind, offer, true);
    return () => {
      for (const kind of kinds) document.removeEventListener(kind, offer, true);
    };
  }, []);
  const submit = useCallback(
    async (keyChord: ComposerKeyChord, delivery?: PromptDelivery) => {
      if (disabled || notSentReason !== undefined || isSubmitting || !hasContent(text, attachments))
        return;

      // A `!` or `$` line is a command: it goes through U2's mode seam, never to the model as a prompt.
      const command = parseComposerMode(text);
      const isCommand = command.mode !== "prompt";
      // A bare `!` or `$` has no command to run: nothing is sent and the line stays.
      if (isCommand && command.text.length === 0) return;
      let intents: readonly PromptIntent[] = [];
      try {
        if (isCommand) {
          if (attachments.length > 0) {
            throw new AppFailure({
              code: "invalid_args",
              message: "Remove the attachments to run a bash or Python command",
              retryable: false,
            });
          }
        } else {
          const input = decisionInput(text, attachments, isStreaming, keyChord);
          const result = delivery === undefined ? policy(input) : { delivery };
          intents = intentsForDecision(result, text, attachments);
          if (isStreaming && intents.some((intent) => intent.delivery === "new")) {
            throw new AppFailure({
              code: "invalid_args",
              message: "A turn is running: choose steer or follow-up",
              retryable: false,
            });
          }
        }
      } catch (cause) {
        setError(appFailure(cause).appError);
        return;
      }
      setError(null);
      setIsSubmitting(true);
      try {
        if (isCommand) {
          await submitModeInput(command, "new", capabilities, submitPrompt);
        } else {
          for (const intent of intents) await submitPrompt(intent);
        }
        await composer.reset();
        inputRef.current?.focus();
      } catch (cause) {
        setError(appFailure(cause).appError);
        inputRef.current?.focus();
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      attachments,
      capabilities,
      composer,
      disabled,
      isStreaming,
      isSubmitting,
      policy,
      notSentReason,
      submitPrompt,
      text,
    ],
  );

  const handleCancel = useCallback(async () => {
    if (!canCancel || sendBlockedReason !== undefined) return;
    try {
      await cancel();
      inputRef.current?.focus();
    } catch (cause) {
      setError(appFailure(cause).appError);
    }
  }, [canCancel, cancel, sendBlockedReason]);

  /** Puts a large paste's text into the box where it was pasted, and tells the runtime the box changed. */
  const insertLargePaste = useCallback((paste: LargePaste): void => {
    const input = inputRef.current;
    if (input === null) return;
    const start = Math.min(paste.selectionStart, input.value.length);
    const end = Math.min(paste.selectionEnd, input.value.length);
    input.setRangeText(paste.text, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);

  const pasteInline = useCallback((): void => {
    if (largePaste === null) return;
    insertLargePaste(largePaste);
    setLargePaste(null);
    inputRef.current?.focus();
  }, [insertLargePaste, largePaste]);

  const attachAsBlock = useCallback(async (): Promise<void> => {
    if (largePaste === null) return;
    const name = pastedTextName(++pasteCount.current, largePaste.lineCount);
    // The choice is answered at once, so a second press cannot add a second copy.
    setLargePaste(null);
    inputRef.current?.focus();
    try {
      await composer.addAttachment(new File([largePaste.text], name, { type: "text/plain" }));
    } catch (cause) {
      // The chip could not be added: the text goes into the box instead, so it is not lost.
      insertLargePaste(largePaste);
      setError(appFailure(cause).appError);
    }
  }, [composer, insertLargePaste, largePaste]);

  const largePasteThreshold = useLargePasteMenuThreshold();
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      // A pasted file is attached by assistant-ui; only plain text can be a large paste.
      if (event.clipboardData.files.length > 0) return;
      const pasted = event.clipboardData.getData("text/plain");
      const decision = classifyLargePaste(pasted, largePasteThreshold);
      if (decision.kind !== "choose") return;
      event.preventDefault();
      // A second large paste while a choice is open: the first goes inline now, so no text is dropped.
      if (largePaste !== null) insertLargePaste(largePaste);
      const input = event.currentTarget;
      setLargePaste({
        text: pasted,
        lineCount: decision.lineCount,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });
    },
    [insertLargePaste, largePaste, largePasteThreshold],
  );

  const handleSubmitCapture = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submit("enter");
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // The double-tap of ← that opens the Agent Hub (omp's gesture). Only the editor's own keys count.
      if (!event.nativeEvent.isComposing && !composingRef.current) {
        const step = arrowGestureStep(arrowGesture.current, {
          key: event.key,
          repeat: event.repeat,
          emptyEditor: text === "" && attachments.length === 0,
          modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
          now: Date.now(),
        });
        arrowGesture.current = step.gesture;
        if (step.doubleTap) onDoubleLeftArrow?.();
      }
      // A large paste waiting for its choice goes inline on Escape, so its text is never lost. A key a trigger list
      // already handled (defaultPrevented) is not the composer's to act on.
      if (
        event.key === "Escape" &&
        largePaste !== null &&
        !event.defaultPrevented &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        pasteInline();
        return;
      }
      // A running turn takes Escape first, in bash and Python mode too: one press stops the turn
      // and the mode stays. With no turn running, Escape or an empty Backspace leaves bash and
      // Python mode for Prompt and keeps the text. A key a trigger list already handled
      // (defaultPrevented) is not the composer's to act on: Escape then only closes the list.
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.nativeEvent.isComposing &&
        canCancel
      ) {
        event.preventDefault();
        void handleCancel();
        return;
      }
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && !composingRef.current) {
        const parsed = parseComposerMode(text);
        if (shouldExitMode(parsed.mode, event.key, parsed.text)) {
          event.preventDefault();
          event.stopPropagation();
          composer.setText(textForMode(text, "prompt"));
          return;
        }
      }
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        composingRef.current
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void submit(enterChord(event));
    },
    [
      attachments,
      canCancel,
      composer,
      handleCancel,
      largePaste,
      onDoubleLeftArrow,
      pasteInline,
      submit,
      text,
    ],
  );

  const chord = chordLabel("Mod+Enter", { mac: isApplePlatform() });
  const steerHint = `Enter steers · ${chord} queues`;
  const steerHintTitle = `Enter steers this turn. ${chord} queues a message for after it.`;

  return (
    <ComposerPrimitive.Root
      className="relative flex w-full flex-col"
      onSubmitCapture={handleSubmitCapture}
      data-composer-surface="u2"
    >
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-composer-card="true"
            className="border-border bg-card shadow-xs focus-within:ring-2 focus-within:ring-ring/50 focus-within:ring-offset-2 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-(--space-sm) rounded-(--radius) border p-(--space-sm) outline-none transition-[border-color,box-shadow] data-[dragging=true]:border-dashed"
          />
        }
      >
        <div
          className="flex flex-col gap-(--space-sm)"
          style={replaced ? { display: "none" } : undefined}
        >
          {showAttachmentNames && (
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <span className="text-muted-foreground px-2 text-xs">{attachment.name}</span>
              )}
            </ComposerPrimitive.Attachments>
          )}
          <ComposerPrimitive.Input
            ref={inputRef}
            aria-label={inputLabel}
            data-focus-scope="composer-input"
            aria-describedby={notSentReason === undefined ? undefined : blockedId}
            data-focus-ring="parent"
            autoFocus={autoFocus}
            cancelOnEscape={false}
            disabled={disabled || isSubmitting}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Send a message..."
            rows={1}
            submitMode="none"
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-[min(13rem,35dvh)] min-h-8 w-full resize-none overflow-y-auto border-0 bg-transparent px-(--space-md) py-(--space-2xs) text-base leading-6 outline-none"
          />
        </div>
        {largePaste !== null && !replaced && (
          <div
            className="flex flex-wrap items-center gap-(--space-xs) px-(--space-md)"
            data-composer-paste-choice="true"
          >
            <p className="text-muted-foreground mr-auto text-sm">
              Pasted {largePaste.lineCount} lines. Where should they go?
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void attachAsBlock()}>
              Attach as a wrapped block
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={pasteInline}>
              Paste inline
            </Button>
          </div>
        )}
        {error && (
          <>
            <div className="px-(--space-md)" data-composer-error="true">
              <InlineError message={error.message} variant="message" />
            </div>
            {error.code === "agent_busy" && (
              <div
                className="flex flex-wrap gap-(--space-xs) px-(--space-md)"
                data-composer-busy-choices="true"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting || notSentReason !== undefined}
                  onClick={() => void submit("enter", "followUp")}
                >
                  Queue it for after
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting || notSentReason !== undefined}
                  onClick={() => void submit("enter", "steer")}
                >
                  Interrupt and send
                </Button>
              </div>
            )}
          </>
        )}
        {notSentReason !== undefined && (
          <p
            className="text-warning px-(--space-md) text-xs"
            data-composer-blocked="true"
            id={blockedId}
          >
            {notSentReason}
          </p>
        )}
        <div
          className="@container flex min-w-0 items-center gap-(--space-xs)"
          data-composer-toolbar="true"
          style={replaced ? { display: "none" } : undefined}
        >
          <ComposerPrimitive.AddAttachment
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Add attachment"
                className="text-muted-foreground hover:text-foreground size-7 rounded-full"
              >
                <PlusIcon aria-hidden="true" className="size-4" />
              </Button>
            }
          />
          {toolbar}
          {isStreaming && notSentReason === undefined && modeForText(text) === "prompt" && (
            <p
              className="text-muted-foreground hidden min-w-0 flex-1 whitespace-nowrap text-xs @[38rem]:block"
              data-composer-steer-hint="true"
              title={steerHintTitle}
            >
              {steerHint}
            </p>
          )}
          <div className="ms-auto flex shrink-0 items-center gap-(--space-xs)">
            {canCancel ? (
              <Button
                type="button"
                variant="default"
                size="icon"
                aria-label="Stop generating"
                disabled={(isSubmitting && !isStreaming) || sendBlockedReason !== undefined}
                aria-describedby={sendBlockedReason === undefined ? undefined : blockedId}
                onClick={() => void handleCancel()}
                className="size-7 rounded-full"
              >
                <SquareIcon aria-hidden="true" className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                size="icon"
                aria-label="Send message"
                disabled={
                  disabled ||
                  isSubmitting ||
                  !hasContent(text, attachments) ||
                  notSentReason !== undefined
                }
                onClick={() => void submit("enter")}
                className="size-7 rounded-full"
              >
                <ArrowUpIcon aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {replaced ? null : queue}
        {children}
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
