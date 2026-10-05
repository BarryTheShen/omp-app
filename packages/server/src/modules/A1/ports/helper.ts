import type { Port, PortHandlers, StreamKey } from "@omp-app/contracts";
import { AppFailure, streamKey } from "@omp-app/contracts";
import type { PortHandler, PortHandlerContext, PortRegistration } from "../../../registry/ports";

/** Publishes a validated store event into A0.6's replay hub. */
export type A1EventPublisher = (stream: StreamKey, payload: unknown) => unknown;

export interface A1EventBinding {
  readonly event: string;
  readonly subscribe: (listener: (payload: unknown) => void) => () => void;
  readonly scope?: (payload: unknown) => string | undefined;
}

/**
 * Turns one typed port implementation into the registry shape and bridges store callbacks into
 * replay streams. A0.6 validates the event payload against the port schema before publication.
 */
export function createA1PortRegistration<P extends Port>(
  port: P,
  handlers: PortHandlers<P, PortHandlerContext>,
  publish: A1EventPublisher | undefined,
  bindings: readonly A1EventBinding[] = [],
): PortRegistration {
  if (publish) {
    for (const binding of bindings) {
      binding.subscribe((payload) => {
        const scope = binding.scope?.(payload);
        publish(streamKey(port.name, binding.event, scope), payload);
      });
    }
  }
  return { port, handlers: handlers as unknown as Readonly<Record<string, PortHandler>> };
}

/** Fails a handler before a non-cancellable store operation starts when the call was cancelled. */
export function assertNotAborted(context: PortHandlerContext): void {
  if (!context.signal.aborted) return;
  throw new AppFailure({
    code: "cancelled",
    message: "The call was cancelled.",
    retryable: false,
  });
}
