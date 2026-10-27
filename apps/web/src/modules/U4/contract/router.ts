/**
 * `ExtensionUiRequestRouter`: owns `UiRequestId`/`HostCallId` correlation end to end, presenting
 * the chat host's dialogs through `DialogHost`, its UI events as `PresentationHandoff`s, and host
 * tool/URI requests through `HostRequestAnswerAdapter` (`modules/U4/README.md` Plan item 5).
 *
 * U4.1 has no dependency on R0 (`modules/U4/README.md` "Needs": C0, U0.1 only), so this router
 * reads pending state through the structural shape below rather than an R0 import: R0's
 * `PendingDialog`/`PendingHostToolRequest`/`PendingHostUriRequest` already have this
 * exact `{ request, receivedSeq }` shape and satisfy it with no cast.
 */
import type { HostCallId, ThreadId, UiRequestId } from "@omp-app/contracts";
import type { HostDialogRequest, HostToolCall, HostUriCall } from "@omp-app/contracts/chat-host";

export interface PendingRequestLike<Request> {
  readonly request: Request;
  readonly receivedSeq: number;
}

export interface RouterContext {
  readonly threadId: ThreadId;
  readonly signal?: AbortSignal;
  readonly sequence?: number;
  /** Replayed from the chat's history rather than new; a replayed notice is shown but not announced again. */
  readonly replayed?: boolean;
}

export interface ExtensionUiRequestRouter {
  /**
   * Presents one of the chat host's dialogs, in `receivedSeq` order across calls.
   * Idempotent per id: routing an id already in flight or already answered is a no-op.
   */
  routeDialog(
    pending: PendingRequestLike<HostDialogRequest>,
    context: RouterContext,
  ): Promise<void>;
  /** Tracks one of the host's calls of the app's tools or URI schemes until it is answered or given up. */
  routeHostRequest(
    pending: PendingRequestLike<HostToolCall | HostUriCall>,
    context: RouterContext,
  ): Promise<void>;
  /** True while `id` still names an open, answerable request; false for a stale or already
   *  settled id. Callers use this instead of inlining their own staleness check. */
  isPending(id: UiRequestId | HostCallId): boolean;
}
