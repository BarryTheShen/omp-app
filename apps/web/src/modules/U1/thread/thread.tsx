/**
 * U1.2's serving-independent assistant-ui thread shell. R0.3 remains the only omp-to-
 * `ThreadMessageLike` converter; this layer only mounts that runtime, supplies stable message rows,
 * and leaves descriptor/domain rendering to slots and U0's registry.
 */
import {
  type EnrichedPartState,
  MessagePrimitive,
  type MessageState,
  type ThreadMessageLike,
  ThreadPrimitive,
} from "@assistant-ui/react";
import type { AppError, DescriptorId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { type ReactNode, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { File } from "@/components/assistant-ui/elements/file";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { cn } from "@/lib/utils";
import {
  credentialFailureFromError,
  credentialFailureFromMessage,
  latestErroredAnswer,
} from "@/modules/D3/auth/credential";
import {
  type CredentialActions,
  CredentialActionsProvider,
} from "@/modules/D3/auth/credential-actions";
import { CredentialFailureNotice } from "@/modules/D3/auth/credential-notice";
import { useDescriptor, useRenderer } from "@/registry-core";
import type { OmpRuntimeStore, RuntimeSnapshot } from "../../R0/store";
import { FullOutputProvider } from "../../U3/tool-card/full-output";
import { failureShownUnderAnswer } from "../parts/message-ending";
import {
  captureVisibleMessageAnchor,
  type MessageScrollAnchor,
  retainVisibleMessageAnchor,
} from "../scroll/anchor";
import type { ReadingPlace } from "../scroll/reading-place";
import { useReadingPlace } from "../scroll/use-reading-place";
import { TurnCancelContext } from "./turn-cancel";

const MESSAGE_DESCRIPTOR_BY_ROLE = {
  user: "U1.userMessage",
  system: "U1.developerMessage",
  assistant: "U1.assistantMessage",
} as const satisfies Partial<Record<MessageState["role"], DescriptorId>>;

export interface ThreadRowSlots {
  /** Replaces U1's default assistant-ui row; the caller owns its row semantics and controls. */
  readonly renderMessage?: (
    message: MessageState,
    renderNested?: ThreadRowSlots["renderNested"],
  ) => ReactNode;
  /** Renders nested messages read-only with the owning tool call's id and name. */
  readonly renderNested?: (
    messages: readonly ThreadMessageLike[],
    taskId: string,
    toolName?: string,
  ) => ReactNode;
}

/** Where the reader is in the open chat, for a reload to return to. Its history may still be loading. */
export interface ThreadReadingPlace {
  readonly threadId: string;
  /** The place a reload that reopens this chat returns to; null for every other open. */
  readonly resumeAt: ReadingPlace | null;
  readonly historyLoading: boolean;
}

export interface ThreadShellProps {
  readonly store: OmpRuntimeStore;
  readonly onRetry?: () => Promise<void> | void;
  /** Starts omp again for this chat; the banner offers it when omp stopped on its own (error code `omp_exited`). */
  readonly onRestartOmp?: () => Promise<void> | void;
  readonly slots?: ThreadRowSlots;
  readonly autoScroll?: boolean;
  readonly footer?: ReactNode;
  /** Loads the page of messages older than the ones shown; the control is offered while the store holds older history. */
  readonly onLoadOlder?: () => Promise<void>;
  /** Loads the full text of a tool output the thread shows shortened (the card offers it when set). */
  readonly onLoadFullOutput?: (toolCallId: string) => Promise<void>;
  /** Where the reader is in this chat. Without it the chat always opens at its newest message. */
  readonly readingPlace?: ThreadReadingPlace;
  /** What a refused-key notice can do: open the model list, open sign-in, and read each provider's sign-in. */
  readonly credentialActions?: CredentialActions;
}

interface RuntimeStateSurfaceProps {
  readonly snapshot: RuntimeSnapshot;
  readonly onRetry?: () => Promise<void> | void;
  readonly onRestartOmp?: () => Promise<void> | void;
}

function RuntimeError({
  error,
  showDetail,
  onRetry,
  onRestartOmp,
}: {
  error: AppError;
  /** Whether the banner repeats omp's words; not when the answer that stopped already says them. */
  showDetail: boolean;
  onRetry?: () => Promise<void> | void;
  onRestartOmp?: () => Promise<void> | void;
}) {
  const [retrying, setRetrying] = useState(false);
  // What the last try said. A refusal that is not retryable (a chat that was never saved cannot be continued) ends
  // the offer: the button would only repeat it.
  const [retryError, setRetryError] = useState<
    { readonly message: string; readonly retryable: boolean } | undefined
  >(undefined);
  // An omp that stopped is started again; any other failure is retried by whoever owns it.
  const stopped = error.code === "omp_exited";
  const action = stopped ? onRestartOmp : onRetry;

  const retry = async () => {
    if (action === undefined || retrying) return;
    setRetrying(true);
    setRetryError(undefined);
    try {
      await action();
    } catch (cause) {
      setRetryError(
        cause instanceof AppFailure
          ? { message: cause.appError.message, retryable: cause.appError.retryable }
          : {
              message: stopped ? "omp could not be restarted" : "Retry failed",
              retryable: true,
            },
      );
    } finally {
      setRetrying(false);
    }
  };

  const failure = credentialFailureFromError(error);
  if (failure !== null) {
    return (
      <div className="mx-auto my-6 w-full max-w-(--layout-thread-width) px-6">
        <CredentialFailureNotice failure={failure} variant="default" />
      </div>
    );
  }

  return (
    <div className="mx-auto my-6 w-full max-w-(--layout-thread-width) px-6">
      <div
        aria-live="assertive"
        className="border-danger bg-danger-surface text-danger-surface-foreground rounded-lg border p-4"
        data-slot="u1-thread-error"
        role="alert"
      >
        <p className="text-sm font-medium">The conversation could not continue.</p>
        {showDetail && <p className="mt-1 text-sm">{error.message}</p>}
        {action !== undefined && retryError?.retryable !== false && (
          <button
            className="border-danger/40 bg-danger-surface-foreground/10 mt-3 rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
            disabled={retrying}
            type="button"
            onClick={() => void retry()}
          >
            {retrying ? (stopped ? "Restarting…" : "Retrying…") : stopped ? "Restart omp" : "Retry"}
          </button>
        )}
        {retryError !== undefined && (
          <p className="text-danger mt-2 text-sm" role="status">
            {retryError.message}
          </p>
        )}
      </div>
    </div>
  );
}

const NO_CREDENTIAL_ACTIONS: CredentialActions = {};

/** Whether the last answer in the transcript is one omp ended because a refused key was not accepted. */
function lastAnswerRefusedKey(snapshot: RuntimeSnapshot): boolean {
  const last = snapshot.messageOrder.at(-1);
  return (
    last !== undefined && credentialFailureFromMessage(snapshot.messages[last]?.message) !== null
  );
}

function RuntimeStateSurface({ snapshot, onRetry, onRestartOmp }: RuntimeStateSurfaceProps) {
  const error = snapshot.error ?? snapshot.process.error;
  // A refused key is said once: under the answer that stopped, when the transcript has that answer.
  const shownUnderAnswer =
    credentialFailureFromError(error) !== null && lastAnswerRefusedKey(snapshot);
  if (error !== null && !shownUnderAnswer) {
    // A provider failure that the most recent failed answer already says is not said again here;
    // the banner keeps its heading.
    const answers = snapshot.messageOrder.map((key) => snapshot.messages[key]?.message);
    const showDetail = !failureShownUnderAnswer(error, latestErroredAnswer(answers));
    return (
      <RuntimeError
        error={error}
        showDetail={showDetail}
        onRetry={onRetry}
        onRestartOmp={onRestartOmp}
      />
    );
  }

  if (snapshot.process.status === "starting" || snapshot.process.status === "restarting") {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground mx-auto flex min-h-32 w-full max-w-(--layout-thread-width) items-center justify-center px-6 py-12 text-sm"
        data-slot="u1-thread-loading"
        role="status"
      >
        Loading conversation…
      </div>
    );
  }

  if (snapshot.messageOrder.length === 0) {
    return (
      <div
        className="text-muted-foreground mx-auto flex min-h-32 w-full max-w-(--layout-thread-width) items-center justify-center px-6 py-12 text-sm"
        data-slot="u1-thread-empty"
      >
        No messages yet.
      </div>
    );
  }

  return null;
}

function RuntimeSettledStatus({ snapshot }: { readonly snapshot: RuntimeSnapshot }) {
  if (snapshot.prompt.streaming) {
    return (
      <div aria-live="polite" className="text-muted-foreground px-2 text-xs" role="status">
        Assistant is working…
      </div>
    );
  }
  if (snapshot.messageOrder.length > 0 && snapshot.process.status === "ready") {
    return (
      <div aria-live="polite" className="text-muted-foreground px-2 text-xs" role="status">
        Conversation settled
      </div>
    );
  }
  return null;
}

function DescriptorMessageBoundary({
  descriptorId,
  fallback,
}: {
  readonly descriptorId: DescriptorId;
  readonly fallback: ReactNode;
}) {
  const descriptor = useDescriptor(descriptorId);
  const Renderer = useRenderer(descriptorId);
  if (descriptor === undefined) return fallback;
  return <Renderer descriptor={descriptor} />;
}

function renderPart(part: EnrichedPartState, slots: ThreadRowSlots | undefined): ReactNode {
  switch (part.type) {
    case "text":
      return <MarkdownText />;
    case "reasoning":
      return <Reasoning {...part} />;
    case "image":
      return <Image {...part} />;
    case "file":
      return <File {...part} />;
    case "tool-call": {
      const nested = Array.isArray(part.messages) ? part.messages : undefined;
      return (
        <>
          {part.toolUI ?? <ToolFallback {...part} />}
          {nested !== undefined && slots?.renderNested?.(nested, part.toolCallId, part.toolName)}
        </>
      );
    }
    case "data":
      return part.dataRendererUI;
    default:
      return (
        <span className="text-muted-foreground text-sm" data-slot="u1-unknown-part">
          Unable to render this message part.
        </span>
      );
  }
}

function MessageRow({ message, slots }: { message: MessageState; slots?: ThreadRowSlots }) {
  const fallback = (
    <MessagePrimitive.Root
      className="mx-auto w-full max-w-(--layout-thread-width) px-6 py-3"
      data-message-id={message.id}
      data-role={message.role}
      data-slot="u1-thread-message"
    >
      <div className="text-foreground min-w-0 wrap-break-word">
        <MessagePrimitive.Parts>{({ part }) => renderPart(part, slots)}</MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );

  const descriptorId = MESSAGE_DESCRIPTOR_BY_ROLE[message.role];
  if (slots?.renderMessage !== undefined) return slots.renderMessage(message, slots.renderNested);
  if (descriptorId === undefined) return fallback;
  return <DescriptorMessageBoundary descriptorId={descriptorId} fallback={fallback} />;
}

/** A click on "Show earlier messages": the row the reader was on, kept until the older rows land. */
interface PendingEarlierLoad {
  readonly button: HTMLElement;
  readonly hadFocus: boolean;
  readonly viewport: HTMLElement;
  readonly anchor: MessageScrollAnchor | null;
  readonly firstMessage: string | undefined;
}

function EarlierMessagesControl({
  onLoad,
}: {
  readonly onLoad: (button: HTMLElement) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const load = async (button: HTMLElement): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      await onLoad(button);
    } catch (cause) {
      setError(
        cause instanceof AppFailure ? cause.appError.message : "Loading earlier messages failed",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-3" data-slot="u1-earlier-messages">
      <button
        aria-disabled={loading || undefined}
        className="border-border bg-background hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-wait aria-disabled:opacity-60"
        type="button"
        onClick={(event) => {
          // aria-disabled, not disabled: a disabled button drops focus, and the reader's focus must stay on it.
          if (!loading) void load(event.currentTarget);
        }}
      >
        {loading ? "Loading earlier messages…" : "Show earlier messages"}
      </button>
      {error !== undefined && (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Renders inside the caller's assistant-ui runtime provider and supplies stable message rows. The
 * composer is intentionally not included: U2 owns that surface and consumes this thread runtime.
 */
export function ThreadShell({
  store,
  onRetry,
  onRestartOmp,
  slots,
  autoScroll = true,
  footer,
  onLoadOlder,
  onLoadFullOutput,
  readingPlace,
  credentialActions,
}: ThreadShellProps) {
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const place = useReadingPlace({
    viewportRef,
    threadId: readingPlace?.threadId,
    resumeAt: readingPlace?.resumeAt ?? null,
    historyLoading: readingPlace?.historyLoading ?? false,
    messageOrder: snapshot.messageOrder,
    hasOlder: snapshot.transcript.hasOlder,
    loadOlder: onLoadOlder,
  });
  const pendingEarlier = useRef<PendingEarlierLoad | null>(null);
  const firstMessage = snapshot.messageOrder[0];
  // Older rows land above the first one: re-anchor the reader's row once they are in the DOM.
  useLayoutEffect(() => {
    const pending = pendingEarlier.current;
    if (pending === null || pending.firstMessage === firstMessage) return;
    pendingEarlier.current = null;
    retainVisibleMessageAnchor(pending.viewport, pending.anchor);
    // The control held focus and is gone because nothing older is left: keep a keyboard reader in the transcript.
    if (pending.hadFocus && !pending.button.isConnected)
      pending.viewport.focus({ preventScroll: true });
    // The layout can still settle after this commit (the control leaves; the viewport follows its own
    // turn anchor). Retain once more on the next frame, from where the first pass left the reader.
    if (pending.anchor === null) return;
    const { anchor, viewport } = pending;
    const frame = requestAnimationFrame(() =>
      retainVisibleMessageAnchor(viewport, { ...anchor, scrollTop: viewport.scrollTop }),
    );
    return () => cancelAnimationFrame(frame);
  }, [firstMessage]);
  const loadEarlier = async (button: HTMLElement): Promise<void> => {
    if (onLoadOlder === undefined) return;
    const before = store.getSnapshot().messageOrder[0];
    const viewport = button.closest<HTMLElement>('[data-slot="u1-thread-viewport"]');
    if (viewport !== null) {
      pendingEarlier.current = {
        button,
        hadFocus: document.activeElement === button,
        viewport,
        anchor: captureVisibleMessageAnchor(viewport),
        firstMessage: before,
      };
    }
    try {
      await onLoadOlder();
    } finally {
      // No older row arrived, so nothing will re-anchor: the capture is dropped.
      if (store.getSnapshot().messageOrder[0] === before) pendingEarlier.current = null;
    }
  };
  return (
    <CredentialActionsProvider value={credentialActions ?? NO_CREDENTIAL_ACTIONS}>
      <FullOutputProvider value={onLoadFullOutput}>
        <ThreadPrimitive.Root
          className="aui-u1-thread bg-background flex h-full min-h-0 min-w-0 flex-col"
          data-slot="u1-thread-root"
        >
          <ThreadPrimitive.Viewport
            ref={viewportRef}
            data-slot="u1-thread-viewport"
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain",
              // While a reload's place settles, every row is drawn, so each height is its real one: a row that is
              // skipped keeps an estimate, and drawing it later moves the place the reader was given. Once settled,
              // drawn rows keep their remembered size (`content-visibility: auto`), so nothing shifts.
              place.resuming &&
                "[overflow-anchor:none] [&_[data-message-id]]:[content-visibility:visible]!",
            )}
            role="region"
            aria-label="Messages"
            aria-live="off"
            tabIndex={0}
            autoScroll={autoScroll && !place.resuming}
            // R0 turns `isRunning` off and on at every turn boundary, so a "run start" also fires in the
            // middle of an answer and would pull a reader who scrolled away down to the bottom. Sending
            // scrolls explicitly instead: the app root calls jumpToLatest when a message is sent, and
            // the transcript then follows the reply (see thread-scroll-controller.ts).
            scrollToBottomOnRunStart={false}
            scrollToBottomOnInitialize={!place.startsAtPlace}
            turnAnchor="bottom"
          >
            <div className="mx-auto flex min-h-full w-full min-w-0 max-w-(--layout-thread-width) shrink-0 flex-col">
              <RuntimeStateSurface
                snapshot={snapshot}
                onRetry={onRetry}
                onRestartOmp={onRestartOmp}
              />
              <div className="flex min-h-0 flex-1 flex-col" data-slot="u1-thread-messages">
                {onLoadOlder !== undefined && snapshot.transcript.hasOlder && (
                  <EarlierMessagesControl onLoad={loadEarlier} />
                )}
                <ThreadPrimitive.Messages>
                  {({ message }) => <MessageRow key={message.id} message={message} slots={slots} />}
                </ThreadPrimitive.Messages>
              </div>
              <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10 mt-auto flex min-h-8 shrink-0 items-center justify-between gap-(--space-md) border-t border-border bg-background px-6 py-2">
                <RuntimeSettledStatus snapshot={snapshot} />
                {footer}
              </ThreadPrimitive.ViewportFooter>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </FullOutputProvider>
    </CredentialActionsProvider>
  );
}

/**
 * A read-only transcript of a worker or a nested task. Its cards never offer the chat's turn stop: a worker's card
 * is not the chat's turn.
 */
export function ReadOnlyNestedTranscript({
  messages,
  label,
  children,
}: {
  readonly messages: readonly ThreadMessageLike[];
  readonly label?: string;
  readonly children: ReactNode;
}) {
  const count = `${messages.length} ${messages.length === 1 ? "message" : "messages"}`;
  const legend = label === undefined ? `${count} in nested transcript` : `${label} · ${count}`;
  return (
    <fieldset
      className="border-border bg-muted/30 mt-2 box-border w-full min-w-0 [min-inline-size:0] rounded-md border px-3 py-2"
      data-read-only="true"
      data-slot="u1-nested-transcript"
    >
      <legend className="text-muted-foreground px-1 text-xs">{legend}</legend>
      <TurnCancelContext.Provider value={undefined}>{children}</TurnCancelContext.Provider>
    </fieldset>
  );
}
