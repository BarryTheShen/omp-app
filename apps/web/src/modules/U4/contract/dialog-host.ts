/**
 * `DialogHost`: the one modal surface every feature dialog shares (`modules/U4/README.md`,
 * "Dialog grammar" and Plan item 1). `restoreFocus` is an injected opaque callback, never a DOM
 * type, so this contract stays independent of U0's `FocusScope` implementation (not yet merged).
 */
import type { ThreadId } from "@omp-app/contracts";
import type { ConfirmDialogRequest, DialogRequest } from "./dialog";
import type { DialogResultFor } from "./responses";

/** Returns focus to exactly the element that had it before the dialog opened. Supplied by the
 *  caller (U0's `FocusScope`, once merged); this contract carries no DOM type. The host calls it
 *  once the dialog has closed and released focus. */
export type FocusRestoreHandle = () => void;
export type DialogOrigin = "omp" | "app";

export interface DialogHostOpenOptions {
  readonly signal?: AbortSignal;
  readonly threadId: ThreadId;
  /** OMP is the default. App-owned dialogs resolve locally without answering an omp request. */
  readonly origin?: DialogOrigin;
  readonly restoreFocus?: FocusRestoreHandle;
}

export interface DialogHost {
  /**
   * Presents one request; later calls for the same thread queue FIFO behind it (one modal per
   * thread). OMP-origin requests (the default) require `omp.ui` and answer omp; app-origin requests
   * use the same overlay and queue but settle locally. App request ids begin with `app-`.
   * Rejects with `AppFailure(unavailable)` when an OMP-origin request lacks `omp.ui`,
   * `AppFailure(conflict)` for a request id already open, or `AppFailure(invalid_args)` for a
   * malformed request.
   */
  open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>>;
  /**
   * The typed `confirm` helper: cancellation, timeout and an explicit "No" all resolve `false`;
   * only an explicit "Yes" resolves `true`. Deny is the default, never approve.
   */
  confirm(request: ConfirmDialogRequest, options: DialogHostOpenOptions): Promise<boolean>;
}
