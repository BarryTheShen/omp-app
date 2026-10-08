"use client";

import type { HostCallId, OmpWire, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useState } from "react";
import { InlineError } from "@/components/blocks";
import type { OverlayHostApi } from "@/overlay";
import type { OmpRuntimeStore, RuntimeNotificationFrame } from "../../R0/store";
import { classifyExtensionUiMethod, toDialogRequest } from "../contract/dialog";
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
  readonly extensionUi: Readonly<Record<string, PendingRequestLike<OmpWire.ExtensionUiRequest>>>;
  readonly hostTools: Readonly<Record<string, PendingRequestLike<OmpWire.HostToolCallRequest>>>;
  readonly hostUris: Readonly<Record<string, PendingRequestLike<OmpWire.HostUriRequest>>>;
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
    <div className="pointer-events-auto flex max-w-sm flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-overlay">
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
  private readonly pending = new Map<
    string,
    "extension" | "host-tool" | "host-uri" | "presentation"
  >();
  private readonly presentationOverlays = new Map<string, string>();
  private readonly failedPresentationIds = new Set<string>();

  public constructor(options: ExtensionUiRouterOptions) {
    this.dialogHost = options.dialogHost;
    this.overlay = options.overlay;
    this.hostAnswers = options.hostAnswers;
    this.presentations = options.presentations;
  }

  public async routeExtensionUi(
    pending: PendingRequestLike<OmpWire.ExtensionUiRequest>,
    context: RouterContext,
  ): Promise<void> {
    const request = pending.request;
    const id = request.id as UiRequestId;
    if (request.method === "cancel") {
      this.dialogHost.cancel(request.targetId as UiRequestId);
      this.closePresentation(request.targetId);
      this.pending.delete(request.targetId);
      return;
    }
    if (this.pending.has(id)) return;
    this.pending.set(
      id,
      classifyExtensionUiMethod(request.method) === "modal" ? "extension" : "presentation",
    );
    try {
      if (classifyExtensionUiMethod(request.method) === "modal") {
        await this.dialogHost.open(toDialogRequest(request), {
          threadId: context.threadId,
          signal: context.signal,
        });
      } else {
        const handoff = toPresentationHandoff(request);
        if (handoff.kind === "open_url") this.routeOAuth(id, handoff);
        else await this.routePresentation(handoff, context, id);
      }
    } finally {
      this.pending.delete(id);
    }
  }

  /** Routes a non-modal request or cancellation from R0's notification-frame subscription. */
  public async routeNotification(
    frame: RuntimeNotificationFrame,
    seq: number,
    context: RouterContext,
  ): Promise<void> {
    if (frame.type !== "extension_ui_request") return;
    if (classifyExtensionUiMethod(frame.method) === "modal") return;
    await this.routeSafely({ request: frame, receivedSeq: seq }, { ...context, sequence: seq });
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
    const requests = [
      ...Object.values(snapshot.extensionUi),
      ...Object.values(snapshot.hostTools),
      ...Object.values(snapshot.hostUris),
    ].sort((left, right) => left.receivedSeq - right.receivedSeq);
    for (const pending of requests) {
      if (pending.request.type === "extension_ui_request") {
        await this.routeSafely(pending as PendingRequestLike<OmpWire.ExtensionUiRequest>, context);
      } else {
        await this.routeHostRequest(
          pending as PendingRequestLike<OmpWire.HostToolCallRequest | OmpWire.HostUriRequest>,
          context,
        );
      }
    }
  }

  private async routeSafely(
    pending: PendingRequestLike<OmpWire.ExtensionUiRequest>,
    context: RouterContext,
  ): Promise<void> {
    try {
      await this.routeExtensionUi(pending, context);
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
    id: UiRequestId,
  ): Promise<void> {
    if (this.presentations) {
      await this.presentations.present(handoff, context);
      return;
    }
    const message = presentationText(handoff);
    const overlay = this.overlay.open({
      kind: "toast",
      content: (
        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground">
          {message}
        </div>
      ),
    });
    this.presentationOverlays.set(String(id), overlay.id);
    void overlay.closed;
  }

  private routeOAuth(id: UiRequestId, handoff: OpenUrlHandoff): void {
    safeHttpUrl(handoff.url);
    if (handoff.launchUrl) safeHttpUrl(handoff.launchUrl);
    const overlay = this.overlay.open({
      kind: "popover",
      content: ({ close }) => (
        <OAuthPrompt handoff={handoff} onDone={() => close("programmatic")} />
      ),
    });
    this.presentationOverlays.set(String(id), overlay.id);
  }

  private closePresentation(id: string): void {
    const overlayId = this.presentationOverlays.get(id);
    if (overlayId) this.overlay.close(overlayId, "programmatic");
    this.presentationOverlays.delete(id);
  }
}

export function subscribeNonModalExtensionUi(
  store: Pick<OmpRuntimeStore, "subscribeNotifications">,
  router: ExtensionUiRequestRouterController,
  context: RouterContext,
): () => void {
  return store.subscribeNotifications(
    ["extension_ui_request"],
    (frame, seq) => void router.routeNotification(frame, seq, context),
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
