import type { Port, PortHandlers, StreamKey } from "@omp-app/contracts";
import { AppFailure, streamKey } from "@omp-app/contracts";
import type { PortHandler, PortHandlerContext, PortRegistration } from "../../../registry/ports";

/** Publishes a validated store event into A0.6's replay hub. */
export type A1EventPublisher = (stream: StreamKey, payload: unknown) => unknown;

/** Starts/stops a store watcher when a matching replay stream gains/loses its last client. */
export type A1StreamActivity = (
  prefix: string,
  listener: (stream: StreamKey, active: boolean) => void,
) => () => void;

export interface A1EventBinding {
  readonly event: string;
  /** A global store subscription installed with the registration. */
  readonly subscribe?: (listener: (payload: unknown) => void) => () => void;
  /** A scoped store subscription started only while one matching stream is active. */
  readonly subscribeScoped?: (scope: string, listener: (payload: unknown) => void) => () => void;
  readonly scope?: (payload: unknown) => string | undefined;
}

/**
 * Turns one typed port implementation into the registry shape and bridges store callbacks into
 * replay streams. Scoped bindings are activated by A0.6 stream activity, so idle clients do not
 * leave per-folder/per-thread filesystem watchers alive.
 */
export function createA1PortRegistration<P extends Port>(
  port: P,
  handlers: PortHandlers<P, PortHandlerContext>,
  publish: A1EventPublisher,
  bindings: readonly A1EventBinding[] = [],
  watchActivity: A1StreamActivity,
): PortRegistration {
  for (const binding of bindings) {
    if (binding.subscribe) {
      binding.subscribe((payload) => {
        const scope = binding.scope?.(payload);
        publish(streamKey(port.name, binding.event, scope), payload);
      });
      continue;
    }
    if (!binding.subscribeScoped) continue;
    const prefix = `${port.name}/${binding.event}/`;
    const active = new Map<string, () => void>();
    watchActivity(prefix, (stream, isActive) => {
      const scope = stream.slice(prefix.length);
      if (isActive) {
        if (active.has(scope)) return;
        const dispose = binding.subscribeScoped?.(scope, (payload) => publish(stream, payload));
        if (dispose) active.set(scope, dispose);
        return;
      }
      const dispose = active.get(scope);
      if (!dispose) return;
      active.delete(scope);
      dispose();
    });
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
