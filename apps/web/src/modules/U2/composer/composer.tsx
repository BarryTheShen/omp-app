import { type Attachment, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { AppError, AttachmentRef, CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { ArrowUpIcon, PlusIcon, SquareIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { chordLabel, isApplePlatform } from "@/shortcuts";
import { Button } from "../../../components/ui/button";
import type { PromptDelivery, PromptIntent } from "../../R0/runtime/runtime";
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
  readonly showAttachmentNames?: boolean;
  readonly toolbar?: ReactNode;
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

const NO_CAPABILITIES: CapabilityMap = Object.freeze({});

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
  showAttachmentNames = true,
  toolbar,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const composingRef = useRef(false);
  const arrowGesture = useRef<ArrowGesture>(NO_ARROW_GESTURE);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const blockedId = useId();
  useRemeasureOnWidthChange(inputRef);
  const submit = useCallback(
    async (keyChord: ComposerKeyChord, delivery?: PromptDelivery) => {
      if (
        disabled ||
        sendBlockedReason !== undefined ||
        isSubmitting ||
        !hasContent(text, attachments)
      )
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
      sendBlockedReason,
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
      // A running turn takes Escape first, in bash and Python mode too: one press stops the turn
      // and the mode stays. With no turn running, Escape or an empty Backspace leaves bash and
      // Python mode for Prompt and keeps the text. A key a trigger list already handled
      // (defaultPrevented) is not the composer's to act on.
      if (event.key === "Escape" && !event.nativeEvent.isComposing && canCancel) {
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
    [attachments, canCancel, composer, handleCancel, onDoubleLeftArrow, submit, text],
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
            aria-describedby={sendBlockedReason === undefined ? undefined : blockedId}
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
            placeholder="Send a message..."
            rows={1}
            submitMode="none"
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-[min(13rem,35dvh)] min-h-8 w-full resize-none overflow-y-auto border-0 bg-transparent px-(--space-md) py-(--space-2xs) text-base leading-6 outline-none"
          />
        </div>
        {error && (
          <>
            <p
              data-composer-error="true"
              role="alert"
              className="text-destructive px-(--space-md) text-sm"
            >
              {error.message}
            </p>
            {error.code === "agent_busy" && (
              <div
                className="flex flex-wrap gap-(--space-xs) px-(--space-md)"
                data-composer-busy-choices="true"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => void submit("enter", "followUp")}
                >
                  Queue it for after
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => void submit("enter", "steer")}
                >
                  Interrupt and send
                </Button>
              </div>
            )}
          </>
        )}
        {sendBlockedReason !== undefined && (
          <p
            className="text-warning px-(--space-md) text-xs"
            data-composer-blocked="true"
            id={blockedId}
          >
            {sendBlockedReason}
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
          {isStreaming && sendBlockedReason === undefined && modeForText(text) === "prompt" && (
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
                  sendBlockedReason !== undefined
                }
                onClick={() => void submit("enter")}
                className="size-7 rounded-full"
              >
                <ArrowUpIcon aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {children}
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
