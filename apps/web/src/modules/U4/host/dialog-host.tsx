"use client";

import type { AppError, CapabilityMap, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { ReactNode } from "react";
import type { OverlayHostApi, OverlayOpenResult } from "@/overlay";
import {
  DIALOG_CAPABILITY,
  type DialogRequest,
  DialogRequestSchema,
  dialogName,
} from "../contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../contract/dialog-host";
import {
  type DialogResponse,
  DialogResponseSchema,
  type DialogResult,
  type DialogResultFor,
  defaultDialogResult,
  toWireExtensionUiResponse,
  validateAskAnswers,
} from "../contract/responses";

export interface DialogRenderContext {
  readonly request: DialogRequest;
  readonly threadId: ThreadId;
  readonly signal: AbortSignal;
  readonly answer: (response: DialogResponse) => Promise<void>;
  readonly cancel: () => Promise<void>;
  /**
   * When (epoch ms) the host settles this request on its own timer, because no answer came. Undefined when the request
   * has no timeout. A request queued behind another dialog keeps the time it was received, as its timer does.
   */
  readonly deadlineAt?: number;
}

export type DialogRenderer = (request: DialogRequest, context: DialogRenderContext) => ReactNode;

export interface DialogHostControllerOptions {
  readonly overlay: OverlayHostApi;
  /**
   * The capability map, or a function that returns the current one. Pass the function from a long
   * lived owner: the host is not rebuilt (cancelling an open question) when a map is replaced.
   */
  readonly capabilities?: CapabilityMap | (() => CapabilityMap | undefined);
  readonly answerExtensionUi: (
    response: OmpWire.ExtensionUiResponse,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly render: DialogRenderer;
}

interface DialogEntry {
  readonly request: DialogRequest;
  readonly options: DialogHostOpenOptions;
  readonly resolve: (result: DialogResult) => void;
  readonly reject: (error: unknown) => void;
  readonly abortController: AbortController;
  readonly restoreFocus?: () => void;
  state: "queued" | "active" | "settling" | "settled";
  overlay: OverlayOpenResult | null;
  deadlineAt: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | null;
  internalClose: boolean;
  restoreCalled: boolean;
}

function failure(code: AppError["code"], message: string): AppFailure {
  return new AppFailure({ code, message, retryable: code === "internal" });
}

function invalidRequest(): AppFailure {
  return failure("invalid_args", "The dialog request failed validation.");
}

function unavailableUi(): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: "Interactive extension UI is unavailable for this runtime.",
    retryable: false,
    capability: DIALOG_CAPABILITY,
  });
}

function conflict(message: string): AppFailure {
  return failure("conflict", message);
}

function asFailure(error: unknown, message: string): AppFailure {
  return error instanceof AppFailure
    ? error
    : new AppFailure({ code: "internal", message, retryable: true }, { cause: error });
}

function isUiAvailable(capabilities: CapabilityMap | undefined): boolean {
  return capabilities?.[DIALOG_CAPABILITY]?.state === "available";
}

/** U4.2's one-modal-per-thread host. OMP-origin answers use the injected R0 action; app-origin
 *  dialogs share the queue and overlay but settle locally. */
export class DialogHostController implements DialogHost {
  private readonly overlay: OverlayHostApi;
  private readonly capabilities: CapabilityMap | (() => CapabilityMap | undefined) | undefined;
  private readonly answerExtensionUi: DialogHostControllerOptions["answerExtensionUi"];
  private readonly render: DialogRenderer;
  private readonly queues = new Map<string, DialogEntry[]>();
  private readonly active = new Map<string, DialogEntry>();
  private readonly entries = new Map<string, DialogEntry>();
  private activeThread: ThreadId | null = null;
  private disposed = false;

  public constructor(options: DialogHostControllerOptions) {
    this.overlay = options.overlay;
    this.capabilities = options.capabilities;
    this.answerExtensionUi = options.answerExtensionUi;
    this.render = options.render;
  }

  public open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    if (this.disposed)
      return Promise.reject(failure("internal", "The dialog host has been disposed."));
    const origin = options.origin ?? "omp";
    const capabilities =
      typeof this.capabilities === "function" ? this.capabilities() : this.capabilities;
    if (origin === "omp" && !isUiAvailable(capabilities)) {
      return Promise.reject(unavailableUi());
    }
    const parsed = DialogRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(invalidRequest());
    if (origin === "app" && !parsed.data.id.startsWith("app-")) {
      return Promise.reject(
        failure("invalid_args", "App dialog request ids must start with app-."),
      );
    }
    // An app dialog belongs to the chat it was opened in. A host that shows another chat cannot present
    // it, and nothing switches this host to that chat, so it is refused now instead of waiting forever.
    if (origin === "app" && this.activeThread !== null && this.activeThread !== options.threadId) {
      return Promise.reject(
        failure("unavailable", "That chat is not open, so this dialog cannot be shown here."),
      );
    }
    if (this.entries.has(parsed.data.id)) {
      return Promise.reject(conflict("A dialog with this request id is already open."));
    }

    const entryOptions = { ...options, origin };
    return new Promise<DialogResultFor<R>>((resolve, reject) => {
      const entry: DialogEntry = {
        request: parsed.data,
        options: entryOptions,
        resolve: resolve as unknown as (result: DialogResult) => void,
        reject,
        abortController: new AbortController(),
        restoreFocus: entryOptions.restoreFocus,
        state: "queued",
        overlay: null,
        timer: undefined,
        abortListener: null,
        internalClose: false,
        restoreCalled: false,
        deadlineAt: undefined,
      };
      this.entries.set(parsed.data.id, entry);
      const key = String(entryOptions.threadId);
      const queue = this.queues.get(key) ?? [];
      queue.push(entry);
      this.queues.set(key, queue);
      this.installAbort(entry);
      if (entry.state === "queued") this.installTimeout(entry);
      if (this.activeThread === null) this.activeThread = entryOptions.threadId;
      if (this.activeThread === entryOptions.threadId) this.startNext(entryOptions.threadId);
    });
  }

  public async confirm(
    request: Extract<DialogRequest, { kind: "confirm" }>,
    options: DialogHostOpenOptions,
  ): Promise<boolean> {
    const result = await this.open(request, options);
    return (
      result.outcome === "answered" &&
      result.response.kind === "confirm" &&
      result.response.confirmed
    );
  }

  /** Closes a request removed by R0/omp without answering it. A stale id is intentionally ignored. */
  public cancel(requestId: UiRequestId): void {
    const entry = this.entries.get(String(requestId));
    if (!entry || entry.state === "settled") return;
    this.settleCancelled(entry, false, false);
  }

  /** Switches the visible thread. Other-thread active/queued requests close locally without a wire answer. */
  public switchThread(threadId: ThreadId): void {
    if (this.disposed || this.activeThread === threadId) return;
    const previous = this.activeThread;
    this.activeThread = threadId;
    if (previous !== null) {
      const oldEntries = [
        ...(this.active.get(String(previous))
          ? [this.active.get(String(previous)) as DialogEntry]
          : []),
        ...(this.queues.get(String(previous)) ?? []),
      ];
      for (const entry of oldEntries) this.settleCancelled(entry, false, false);
      this.queues.delete(String(previous));
      this.active.delete(String(previous));
    }
    this.startNext(threadId);
  }

  /** Settles every local request during app teardown; no stale wire answer is manufactured. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) this.settleCancelled(entry, false, false);
    this.queues.clear();
    this.active.clear();
  }

  private installAbort(entry: DialogEntry): void {
    const signal = entry.options.signal;
    if (!signal) return;
    const abort = () => {
      if (entry.state === "queued" || entry.state === "active") {
        void this.settleCancelled(entry, false, true);
      }
    };
    entry.abortListener = abort;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  private installTimeout(entry: DialogEntry): void {
    const timeoutMs = entry.request.kind === "editor" ? undefined : entry.request.timeoutMs;
    if (timeoutMs === undefined) return;
    entry.deadlineAt = Date.now() + timeoutMs;
    this.armTimeout(entry, timeoutMs);
  }

  /** Settles a question on its timer, unless it has been answered or closed by then. */
  private armTimeout(entry: DialogEntry, delayMs: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.state === "queued" || entry.state === "active") {
        void this.settleTimeout(entry);
      }
    }, delayMs);
  }

  private startNext(threadId: ThreadId): void {
    if (this.disposed || this.active.has(String(threadId))) return;
    const queue = this.queues.get(String(threadId));
    if (!queue) return;
    let entry = queue.shift();
    while (entry && entry.state !== "queued") entry = queue.shift();
    if (!entry) {
      this.queues.delete(String(threadId));
      return;
    }
    entry.state = "active";
    this.active.set(String(threadId), entry);
    this.present(entry);
  }

  private present(entry: DialogEntry): void {
    const context: DialogRenderContext = {
      request: entry.request,
      threadId: entry.options.threadId,
      signal: entry.abortController.signal,
      answer: (response) => this.answer(entry, response),
      cancel: () => this.settleCancelled(entry, false, true),
      deadlineAt: entry.deadlineAt,
    };
    try {
      entry.overlay = this.overlay.open({
        kind: "modal",
        label: dialogName(entry.request),
        content: () => this.render(entry.request, context),
        restoreFocus:
          entry.restoreFocus === undefined ? undefined : () => this.restoreAfterClose(entry),
        // omp is waiting on these answers, so a stray press must not answer them; Escape still does.
        // The app's own dialogs keep closing on a press outside, as Escape does.
        closeOnOutsidePointer: entry.options.origin === "app",
      });
      void entry.overlay.closed.then((reason) => {
        if (entry.state !== "active" || entry.internalClose) return;
        if (reason === "unmount") this.settleCancelled(entry, false, false);
        else this.settleCancelled(entry, false, true);
      });
    } catch (error) {
      this.finishRejected(entry, asFailure(error, "Opening the dialog failed."));
    }
  }

  private async answer(entry: DialogEntry, response: DialogResponse): Promise<void> {
    // A press while the first answer is still being sent is ignored: that send's outcome decides what the dialog shows.
    if (entry.state === "settling") return;
    if (entry.state !== "active") throw conflict("The dialog request is no longer pending.");
    const parsed = DialogResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.kind !== entry.request.kind) {
      throw invalidRequest();
    }
    if (entry.request.kind === "ask" && parsed.data.kind === "ask") {
      const validation = validateAskAnswers(entry.request, parsed.data.answers);
      if (!validation.ok) throw failure("invalid_args", "The ask response failed validation.");
    }
    const result: DialogResult = { outcome: "answered", response: parsed.data };
    try {
      await this.settleAndFinish(entry, result);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "not_found") {
        // omp no longer holds this question (its request or its chat is gone), so there is nothing to send to.
        this.finishResolved(entry, defaultDialogResult(entry.request, { timedOut: false }));
        return;
      }
      // omp did not receive the answer, so the question stays open with what the person entered. The caller says
      // the send failed, so the same answer can be sent again.
      this.reopenAfterFailedSend(entry);
      throw error;
    }
  }

  /** Keeps a question open after its answer failed to send: omp still waits for an answer, so the same one can go again. */
  private reopenAfterFailedSend(entry: DialogEntry): void {
    entry.state = "active";
    if (this.disposed || this.active.get(String(entry.options.threadId)) !== entry) {
      // The chat was left or the host closed while the send was in flight: close the dialog as a chat switch does.
      void this.settleCancelled(entry, false, false);
    } else if (entry.options.signal?.aborted) {
      void this.settleCancelled(entry, false, true);
    } else if (entry.deadlineAt !== undefined) {
      // A deadline that passed while the send was in flight settles the question at once.
      this.armTimeout(entry, Math.max(0, entry.deadlineAt - Date.now()));
    }
  }

  private settleTimeout(entry: DialogEntry): Promise<void> {
    const result = defaultDialogResult(entry.request, { timedOut: true });
    return this.settleAndFinish(entry, result).catch((error) => {
      this.finishRejected(entry, error);
    });
  }

  private settleCancelled(
    entry: DialogEntry,
    timedOut: boolean,
    sendAnswer: boolean,
  ): Promise<void> {
    if (entry.state === "settled" || entry.state === "settling") return Promise.resolve();
    const result = defaultDialogResult(entry.request, { timedOut });
    if (!sendAnswer) {
      this.finishResolved(entry, result);
      return Promise.resolve();
    }
    return this.settleAndFinish(entry, result).catch((error) => {
      this.finishRejected(entry, error);
    });
  }

  private async settleAndFinish(entry: DialogEntry, result: DialogResult): Promise<void> {
    if (entry.state === "settled" || entry.state === "settling") return;
    if (entry.options.origin === "app") {
      this.finishResolved(entry, result);
      return;
    }
    entry.state = "settling";
    const wire = toWireExtensionUiResponse(entry.request.id, result);
    try {
      await this.answerExtensionUi(wire);
    } catch (error) {
      throw asFailure(error, "Answering the dialog request failed.");
    }
    this.finishResolved(entry, result);
  }

  private finishResolved(entry: DialogEntry, result: DialogResult): void {
    if (entry.state === "settled") return;
    // A presented dialog's focus scope restores focus once it has unmounted (see `present`); a dialog that was
    // never shown restores focus here.
    const presented = entry.overlay !== null;
    this.finishEntry(entry);
    let restoreError: AppFailure | undefined;
    try {
      if (!presented) this.restoreFocus(entry);
    } catch (error) {
      restoreError = asFailure(error, "Restoring focus after the dialog failed.");
    }
    if (restoreError) entry.reject(restoreError);
    else entry.resolve(result);
    this.advance(entry);
  }

  private finishRejected(entry: DialogEntry, error: unknown): void {
    if (entry.state === "settled") return;
    const presented = entry.overlay !== null;
    this.finishEntry(entry);
    let restoreError: AppFailure | undefined;
    try {
      if (!presented) this.restoreFocus(entry);
    } catch (focusError) {
      restoreError = asFailure(focusError, "Restoring focus after the dialog failed.");
    }
    entry.reject(
      restoreError ??
        (error instanceof AppFailure ? error : asFailure(error, "The dialog failed.")),
    );
    this.advance(entry);
  }

  private finishEntry(entry: DialogEntry): void {
    entry.state = "settled";
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.options.signal && entry.abortListener) {
      entry.options.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = null;
    }
    entry.abortController.abort();
    this.entries.delete(String(entry.request.id));
    const threadKey = String(entry.options.threadId);
    if (this.active.get(threadKey) === entry) this.active.delete(threadKey);
    else {
      const queue = this.queues.get(threadKey);
      if (queue)
        this.queues.set(
          threadKey,
          queue.filter((candidate) => candidate !== entry),
        );
    }
    if (entry.overlay) {
      entry.internalClose = true;
      this.overlay.close(entry.overlay.id, "programmatic");
      entry.overlay = null;
    }
  }

  private advance(entry: DialogEntry): void {
    if (!this.disposed && this.activeThread === entry.options.threadId) {
      this.startNext(entry.options.threadId);
    }
  }

  private restoreFocus(entry: DialogEntry): void {
    if (entry.restoreCalled) return;
    entry.restoreCalled = true;
    entry.restoreFocus?.();
  }

  /** Called by the overlay once its focus scope has unmounted and released the focus trap. */
  private restoreAfterClose(entry: DialogEntry): undefined {
    this.restoreFocus(entry);
    return undefined;
  }
}
