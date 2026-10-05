"use client";

import type { AppError, CapabilityMap, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { ReactNode } from "react";
import type { OverlayHostApi, OverlayOpenResult } from "@/overlay";
import { DIALOG_CAPABILITY, type DialogRequest, DialogRequestSchema } from "../contract/dialog";
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
}

export type DialogRenderer = (request: DialogRequest, context: DialogRenderContext) => ReactNode;

export interface DialogHostControllerOptions {
  readonly overlay: OverlayHostApi;
  readonly capabilities?: CapabilityMap;
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

/** U4.2's one-modal-per-thread host. Request state is local presentation state; R0 remains the
 *  source of truth for pending requests and is called only through the injected answer action. */
export class DialogHostController implements DialogHost {
  private readonly overlay: OverlayHostApi;
  private readonly capabilities: CapabilityMap | undefined;
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
    if (!isUiAvailable(this.capabilities)) return Promise.reject(unavailableUi());
    const parsed = DialogRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(invalidRequest());
    if (this.entries.has(parsed.data.id)) {
      return Promise.reject(conflict("A dialog with this request id is already open."));
    }

    return new Promise<DialogResultFor<R>>((resolve, reject) => {
      const entry: DialogEntry = {
        request: parsed.data,
        options,
        resolve: resolve as unknown as (result: DialogResult) => void,
        reject,
        abortController: new AbortController(),
        restoreFocus: options.restoreFocus,
        state: "queued",
        overlay: null,
        timer: undefined,
        abortListener: null,
        internalClose: false,
        restoreCalled: false,
      };
      this.entries.set(parsed.data.id, entry);
      const key = String(options.threadId);
      const queue = this.queues.get(key) ?? [];
      queue.push(entry);
      this.queues.set(key, queue);
      this.installAbort(entry);
      this.installTimeout(entry);
      if (this.activeThread === null) this.activeThread = options.threadId;
      if (this.activeThread === options.threadId) this.startNext(options.threadId);
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
    entry.timer = setTimeout(() => {
      if (entry.state === "queued" || entry.state === "active") {
        void this.settleTimeout(entry);
      }
    }, timeoutMs);
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
    };
    try {
      entry.overlay = this.overlay.open({
        kind: "modal",
        label: entry.request.kind,
        content: () => this.render(entry.request, context),
        restoreFocus: entry.restoreFocus === undefined ? undefined : false,
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
      await this.sendAndFinish(entry, result);
    } catch (error) {
      this.finishRejected(entry, error);
      throw error;
    }
  }

  private settleTimeout(entry: DialogEntry): Promise<void> {
    const result = defaultDialogResult(entry.request, { timedOut: true });
    return this.sendAndFinish(entry, result).catch((error) => {
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
    return this.sendAndFinish(entry, result).catch((error) => {
      this.finishRejected(entry, error);
    });
  }

  private async sendAndFinish(entry: DialogEntry, result: DialogResult): Promise<void> {
    if (entry.state === "settled" || entry.state === "settling") return;
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
    this.finishEntry(entry);
    let restoreError: AppFailure | undefined;
    try {
      this.restoreFocus(entry);
    } catch (error) {
      restoreError = asFailure(error, "Restoring focus after the dialog failed.");
    }
    if (restoreError) entry.reject(restoreError);
    else entry.resolve(result);
    this.advance(entry);
  }

  private finishRejected(entry: DialogEntry, error: unknown): void {
    if (entry.state === "settled") return;
    this.finishEntry(entry);
    let restoreError: AppFailure | undefined;
    try {
      this.restoreFocus(entry);
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
}
