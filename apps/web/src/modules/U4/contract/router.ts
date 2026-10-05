/**
 * `ExtensionUiRequestRouter`: owns `UiRequestId`/`HostCallId` correlation end to end, presenting
 * modal requests through `DialogHost`, non-modal requests as `PresentationHandoff`s, and host
 * tool/URI requests through `HostRequestAnswerAdapter` (`modules/U4/README.md` Plan item 5).
 *
 * U4.1 has no dependency on R0 (`modules/U4/README.md` "Needs": C0, U0.1 only), so this router
 * reads pending state through the structural shape below rather than an R0 import: R0.1's
 * `PendingExtensionUiRequest`/`PendingHostToolRequest`/`PendingHostUriRequest` already have this
 * exact `{ request, receivedSeq }` shape and satisfy it with no cast.
 */
import type { HostCallId, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";

export interface PendingRequestLike<Request> {
  readonly request: Request;
  readonly receivedSeq: number;
}

export interface RouterContext {
  readonly threadId: ThreadId;
  readonly signal?: AbortSignal;
}

export interface ExtensionUiRequestRouter {
  /**
   * Presents or hands off one extension-UI request, in `receivedSeq` order across calls.
   * Idempotent per id: routing an id already in flight or already answered is a no-op.
   */
  routeExtensionUi(
    pending: PendingRequestLike<OmpWire.ExtensionUiRequest>,
    context: RouterContext,
  ): Promise<void>;
  /** Answers one host tool/URI request through the typed `HostRequestAnswerAdapter`. */
  routeHostRequest(
    pending: PendingRequestLike<OmpWire.HostToolCallRequest | OmpWire.HostUriRequest>,
    context: RouterContext,
  ): Promise<void>;
  /** True while `id` still names an open, answerable request; false for a stale or already
   *  settled id. Callers use this instead of inlining their own staleness check. */
  isPending(id: UiRequestId | HostCallId): boolean;
}
