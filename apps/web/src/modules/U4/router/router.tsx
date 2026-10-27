"use client";

import type { HostCallId, OmpWire, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { HostDialogRequest, UiPresentationEvent } from "@omp-app/contracts/chat-host";
import { useState } from "react";
import { InlineError } from "@/components/blocks";
import type { OverlayHostApi } from "@/overlay";
import type { OmpRuntimeStore, RuntimeNotificationFrame } from "../../R0/store";
import { toDialogRequest } from "../contract/dialog";
import type { DialogHost } from "../contract/dialog-host";
import type { HostRequestAnswer, HostRequestAnswerAdapter } from "../contract/host-answers";
import {
  type OpenUrlHandoff,
  openUrlCopyTarget,
  type PresentationHandoff,
  toPresentationHandoff,
} from "../contract/presentation";
import type {
  ExtensionUiRequestRouter,
  PendingRequestLike,
  RouterContext,
} from "../contract/router";

type CancellableDialogHost = DialogHost & { readonly cancel: (requestId: UiRequestId) => void };
export interface PresentationSink {
  readonly present: (
    handoff: Exclude<PresentationHandoff, { readonly kind: "open_url" }>,
    context: RouterContext,
  ) => void | Promise<void>;
}

export interface RouterPendingSnapshot {
  readonly dialogs: Readonly<Record<string, PendingRequestLike<HostDialogRequest>>>;
  readonly hostTools: Readonly<Record<string, PendingRequestLike<OmpWire.HostToolCallRequest>>>;
  readonly hostUris: Readonly<Record<string, PendingRequestLike<OmpWire.HostUriRequest>>>;
}

/** The chat host's UI events the router presents: everything that needs no answer. */
const PRESENTATION_EVENT_TYPES = [
  "ui_notify",
  "ui_status",
  "ui_widget",
  "ui_title",
  "ui_editor_text",
  "ui_open_url",
] as const satisfies readonly UiPresentationEvent["type"][];

function isPresentationEvent(frame: RuntimeNotificationFrame): frame is UiPresentationEvent {
  return (PRESENTATION_EVENT_TYPES as readonly string[]).includes(frame.type);
}
export interface ExtensionUiRouterOptions {
  readonly dialogHost: CancellableDialogHost;
  readonly overlay: OverlayHostApi;
  readonly hostAnswers: HostRequestAnswerAdapter;
  readonly presentations?: PresentationSink;
}

interface OAuthPromptProps {
  readonly handoff: OpenUrlHandoff;
  readonly onDone: () => void;
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function conflict(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: false });
}

function safeHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("The authorization destination is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("Only http(s) authorization destinations can be opened.");
  }
  if (parsed.username || parsed.password) {
    throw invalid("Authorization destinations cannot contain embedded credentials.");
  }
  return parsed;
}

function OAuthPrompt({ handoff, onDone }: OAuthPromptProps) {
  const [status, setStatus] = useState<string | null>(null);
  const destination = safeHttpUrl(handoff.url);
  const copyTarget = openUrlCopyTarget(handoff);

  const open = () => {
    window.open(copyTarget, "_blank", "noopener,noreferrer");
    setStatus("Opened in a new window.");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyTarget);
      setStatus("Short authorization link copied.");
    } catch {
      setStatus("Copy is unavailable; use the provider's manual callback.");
    }
  };

  return (
    <div className="pointer-events-auto flex max-w-sm flex-col gap-3 rounded-surface border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-none">
      <div>
        <h2 className="text-base font-medium">Continue sign-in</h2>
        <p className="mt-1 text-sm text-muted-foreground">Destination: {destination.host}</p>
        {handoff.instructions ? <p className="mt-2 text-sm">{handoff.instructions}</p> : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm"
          onClick={onDone}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm"
          onClick={() => void copy()}
        >
          Copy link
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
          onClick={open}
        >
          Open sign-in
        </button>
      </div>
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </div>
  );
}

/** Routes R0 pending requests through U4 modal/presentation/host answer seams. */
export class ExtensionUiRequestRouterController implements ExtensionUiRequestRouter {
  private readonly dialogHost: CancellableDialogHost;
  private readonly overlay: OverlayHostApi;
  private readonly hostAnswers: HostRequestAnswerAdapter;
  private readonly presentations: PresentationSink | undefined;
  private readonly pending = new Map<string, "dialog" | "host-tool" | "host-uri">();
  private readonly presentationOverlays = new Map<string, string>();
  private readonly failedPresentationIds = new Set<string>();

  public constructor(options: ExtensionUiRouterOptions) {
    this.dialogHost = options.dialogHost;
    this.overlay = options.overlay;
    this.hostAnswers = options.hostAnswers;
    this.presentations = options.presentations;
  }

  public async routeDialog(
    pending: PendingRequestLike<HostDialogRequest>,
    context: RouterContext,
  ): Promise<void> {
    const request = pending.request;
    const id = request.id as UiRequestId;
    if (this.pending.has(id)) return;
    this.pending.set(id, "dialog");
    try {
      await this.dialogHost.open(toDialogRequest(request), {
        threadId: context.threadId,
        signal: context.signal,
      });
    } finally {
      this.pending.delete(id);
    }
  }

  /** Presents one of the chat host's UI events from R0's notification subscription; each is shown once, by its sequence. */
  public async routeNotification(
    frame: RuntimeNotificationFrame,
    seq: number,
    context: RouterContext,
  ): Promise<void> {
    if (!isPresentationEvent(frame)) return;
    // The host's UI events have no id of their own: the event's sequence names its overlay.
    const id = `ui-${seq}`;
    try {
      const handoff = toPresentationHandoff(frame);
      if (handoff.kind === "open_url") this.routeOAuth(id, handoff);
      else await this.routePresentation(handoff, { ...context, sequence: seq }, id);
    } catch {
      this.showRoutingFailure(id);
    }
  }

  public async routeHostRequest(
    pending: PendingRequestLike<OmpWire.HostToolCallRequest | OmpWire.HostUriRequest>,
    _context: RouterContext,
  ): Promise<void> {
    const id = pending.request.id as HostCallId;
    if (this.pending.has(id)) return;
    this.pending.set(id, pending.request.type === "host_tool_call" ? "host-tool" : "host-uri");
  }

  public isPending(id: UiRequestId | HostCallId): boolean {
    return this.pending.has(String(id));
  }

  public async sync(snapshot: RouterPendingSnapshot, context: RouterContext): Promise<void> {
    this.closeDropped(snapshot.dialogs);
    const requests = [
      ...Object.values(snapshot.dialogs).map((pending) => ({ kind: "dialog" as const, pending })),
      ...[...Object.values(snapshot.hostTools), ...Object.values(snapshot.hostUris)].map(
        (pending) => ({ kind: "host" as const, pending }),
      ),
    ].sort((left, right) => left.pending.receivedSeq - right.pending.receivedSeq);
    for (const entry of requests) {
      if (entry.kind === "dialog") await this.routeSafely(entry.pending, context);
      else await this.routeHostRequest(entry.pending, context);
    }
  }

  /**
   * Closes an open dialog whose request R0 no longer holds: the host gave it up (`ui_cancel`), or its process ended, so
   * nothing can answer it now. Nothing is sent back. The newest is closed first, so the host does not hand a dialog
   * queued behind it to one that is about to close.
   */
  private closeDropped(dialogs: RouterPendingSnapshot["dialogs"]): void {
    for (const [id, kind] of [...this.pending].reverse()) {
      if (kind === "dialog" && dialogs[id] === undefined) {
        this.dialogHost.cancel(id as UiRequestId);
      }
    }
  }

  private async routeSafely(
    pending: PendingRequestLike<HostDialogRequest>,
    context: RouterContext,
  ): Promise<void> {
    try {
      await this.routeDialog(pending, context);
    } catch {
      this.showRoutingFailure(String(pending.request.id));
    }
  }

  private showRoutingFailure(requestId: string): void {
    if (this.presentationOverlays.has(requestId) || this.failedPresentationIds.has(requestId))
      return;
    this.failedPresentationIds.add(requestId);
    const overlay = this.overlay.open({
      kind: "toast",
      content: (
        <InlineError
          heading="omp update unavailable"
          message="An omp message could not be shown. Try again."
          variant="compact"
        />
      ),
    });
    this.presentationOverlays.set(requestId, overlay.id);
    void overlay.closed.then(() => {
      if (this.presentationOverlays.get(requestId) === overlay.id)
        this.presentationOverlays.delete(requestId);
    });
  }

  public async answerHost(
    answer: HostRequestAnswer,
    context?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    const id = String(answer.requestId);
    const kind = this.pending.get(id);
    if (kind !== "host-tool" && kind !== "host-uri") {
      throw conflict("The host request is stale or belongs to another request kind.");
    }
    if (answer.kind === "uri-result" && kind !== "host-uri")
      throw invalid("The host URI answer id is not pending.");
    if ((answer.kind === "tool-update" || answer.kind === "tool-result") && kind !== "host-tool") {
      throw invalid("The host tool answer id is not pending.");
    }
    await this.hostAnswers.submit(answer, context);
    if (answer.kind !== "tool-update") this.pending.delete(id);
  }

  public async cancelHost(
    requestId: HostCallId,
    reason: string,
    context?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    const kind = this.pending.get(String(requestId));
    if (kind !== "host-tool" && kind !== "host-uri") throw conflict("The host request is stale.");
    await this.hostAnswers.cancel(requestId, reason, context);
    this.pending.delete(String(requestId));
  }

  private async routePresentation(
    handoff: Exclude<PresentationHandoff, { readonly kind: "open_url" }>,
    context: RouterContext,
    id: string,
  ): Promise<void> {
    if (this.presentations) {
      await this.presentations.present(handoff, context);
      return;
    }
    const message = presentationText(handoff);
    const overlay = this.overlay.open({
      kind: "toast",
      content: (
        <div className="rounded-surface border border-foreground/10 bg-popover px-3 py-2 text-sm text-popover-foreground">
          {message}
        </div>
      ),
    });
    this.presentationOverlays.set(id, overlay.id);
    void overlay.closed;
  }

  private routeOAuth(id: string, handoff: OpenUrlHandoff): void {
    safeHttpUrl(handoff.url);
    if (handoff.launchUrl) safeHttpUrl(handoff.launchUrl);
    const overlay = this.overlay.open({
      kind: "popover",
      content: ({ close }) => (
        <OAuthPrompt handoff={handoff} onDone={() => close("programmatic")} />
      ),
    });
    this.presentationOverlays.set(id, overlay.id);
  }
}

/** Presents the chat host's UI events (`ui_notify`, `ui_status`, …) as R0's store forwards them. */
export function subscribeNonModalExtensionUi(
  store: Pick<OmpRuntimeStore, "subscribeNotifications">,
  router: ExtensionUiRequestRouterController,
  context: RouterContext,
): () => void {
  return store.subscribeNotifications(
    PRESENTATION_EVENT_TYPES,
    (frame, seq, replayed) => void router.routeNotification(frame, seq, { ...context, replayed }),
  );
}

function presentationText(handoff: PresentationHandoff): string {
  switch (handoff.kind) {
    case "notify":
      return handoff.message;
    case "setStatus":
      return handoff.statusText ?? handoff.statusKey;
    case "setWidget":
      return handoff.widgetLines?.join("\n") ?? handoff.widgetKey;
    case "setTitle":
      return handoff.title;
    case "set_editor_text":
      return "Editor text updated";
    case "open_url":
      return "Sign-in is ready to continue";
  }
}

export { safeHttpUrl };
