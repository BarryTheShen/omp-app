import type { AbortSignalLike, Port, PortName, RequestId } from "@omp-app/contracts";
import { PortName as PortNameSchema } from "@omp-app/contracts";

/** Context supplied to every server-side port handler. */
export interface PortHandlerContext {
  readonly signal: AbortSignalLike;
  readonly connectionId: string;
  readonly requestId: RequestId;
  /** Module-specific state supplied when the registration is composed. */
  readonly portContext: unknown;
}

export type PortHandler = (
  args: unknown,
  context: PortHandlerContext,
) => unknown | Promise<unknown>;

/** One port definition and its implementation, composed by the main agent as modules land. */
export interface PortRegistration {
  readonly port: Port;
  readonly handlers: Readonly<Record<string, PortHandler>>;
  readonly context?: unknown;
}

export type PortRegistry = ReadonlyMap<PortName, PortRegistration>;

/**
 * Builds the immutable lookup used by the dispatcher. A registration must implement exactly the
 * methods declared by its port; event definitions are validated when a stream is published.
 */
export function createPortRegistry(registrations: readonly PortRegistration[] = []): PortRegistry {
  const registry = new Map<PortName, PortRegistration>();
  for (const registration of registrations) {
    const name = PortNameSchema.parse(registration.port.name);
    if (registry.has(name)) {
      throw new Error(`Duplicate port registration: ${name}`);
    }
    for (const method of Object.keys(registration.port.methods)) {
      if (typeof registration.handlers[method] !== "function") {
        throw new Error(`Missing handler for ${name}.${method}`);
      }
    }
    for (const handler of Object.keys(registration.handlers)) {
      if (!(handler in registration.port.methods)) {
        throw new Error(`Unknown handler for ${name}.${handler}`);
      }
    }
    registry.set(name, registration);
  }
  return registry;
}

/**
 * The empty default registry, for tests and tools that compose their own. The running app composes
 * its registrations with their runtime contexts (process registry, replay hub, stores) where the
 * server starts: `createPortRegistry([...createA0PortRegistrations(a0), ...createA1PortRegistrations(a1)])`
 * in A0.9's dev command.
 */
export const PORT_REGISTRY: PortRegistry = createPortRegistry();
