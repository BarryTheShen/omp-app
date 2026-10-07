import type { AppError, ClientFrame, RequestId, ServerFrame, StreamKey } from "@omp-app/contracts";

import {
  APP_PROTOCOL,
  AppError as AppErrorSchema,
  AppFailure,
  ClientFrame as ClientFrameSchema,
  PortName as PortNameSchema,
  ResultFrame as ResultFrameSchema,
  StreamKey as StreamKeySchema,
  type WelcomeFrame as WelcomeFrameSchema,
} from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "./logging";
import type { PortHandlerContext, PortRegistration, PortRegistry } from "./registry/ports";
import type { EventReplayHub, ReplayEventFrame } from "./replay";

export interface DispatcherSocket {
  readonly id: string;
  send(frame: ServerFrame): void;
  close(code: number, reason: string): void;
}

export type DispatcherWelcome = z.output<typeof WelcomeFrameSchema>;

export interface DispatcherOptions {
  readonly registry: PortRegistry;
  readonly replay: EventReplayHub;
  readonly welcome: DispatcherWelcome;
  /** Where connections and failed calls are recorded; nothing is logged without one. */
  readonly logger?: Logger;
}

interface PendingCall {
  readonly controller: AbortController;
}

const INTERNAL_ERROR: AppError = {
  code: "internal",
  message: "The port handler failed",
  retryable: false,
};

const CANCELLED_ERROR: AppError = {
  code: "cancelled",
  message: "The call was cancelled",
  retryable: false,
};

function invalidArgs(message = "Invalid arguments"): AppError {
  return { code: "invalid_args", message, retryable: false };
}

function notFound(message: string): AppError {
  return { code: "not_found", message, retryable: false };
}

function protocolError(): AppError {
  return { code: "invalid_args", message: "Invalid app protocol frame", retryable: false };
}

function appErrorFromUnknown(error: unknown): AppError {
  if (error instanceof AppFailure) {
    const parsed = AppErrorSchema.safeParse(error.appError);
    if (parsed.success) return parsed.data;
  }
  return INTERNAL_ERROR;
}

function decodeFrame(text: string | ArrayBuffer | Uint8Array): unknown {
  if (typeof text === "string") return JSON.parse(text);
  const bytes = text instanceof Uint8Array ? text : new Uint8Array(text);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function streamParts(stream: StreamKey): { port: string; event: string } | undefined {
  const firstSlash = stream.indexOf("/");
  if (firstSlash < 1) return undefined;
  const secondSlash = stream.indexOf("/", firstSlash + 1);
  const event = stream.slice(firstSlash + 1, secondSlash < 0 ? undefined : secondSlash);
  if (event.length === 0) return undefined;
  return { port: stream.slice(0, firstSlash), event };
}

function eventSchema(registry: PortRegistry, stream: StreamKey): z.ZodType | undefined {
  const parts = streamParts(stream);
  if (parts === undefined) return undefined;
  const portName = PortNameSchema.safeParse(parts.port);
  if (!portName.success) return undefined;
  const registration = registry.get(portName.data);
  if (registration === undefined) return undefined;
  const events = registration.port.events as Record<string, { payload: z.ZodType }>;
  return events[parts.event]?.payload;
}

/** A stateful dispatcher session for one WebSocket connection. */
export class DispatcherSession {
  readonly #socket: DispatcherSocket;
  readonly #registry: PortRegistry;
  readonly #replay: EventReplayHub;
  readonly #welcome: DispatcherOptions["welcome"];
  readonly #onClose: (() => void) | undefined;
  readonly #logger: Logger | undefined;
  readonly #pending = new Map<RequestId, PendingCall>();
  readonly #subscriptions = new Map<StreamKey, () => void>();
  #greeted = false;
  #closed = false;

  constructor(socket: DispatcherSocket, options: DispatcherOptions, onClose?: () => void) {
    this.#socket = socket;
    this.#registry = options.registry;
    this.#replay = options.replay;
    this.#welcome = options.welcome;
    this.#onClose = onClose;
    this.#logger = options.logger;
  }

  receive(text: string | ArrayBuffer | Uint8Array): void {
    if (this.#closed) return;
    let raw: unknown;
    try {
      raw = decodeFrame(text);
    } catch {
      this.#protocolClose();
      return;
    }
    const parsed = ClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.#protocolClose();
      return;
    }
    const frame: ClientFrame = parsed.data;
    if (!this.#greeted) {
      if (frame.type !== "hello") {
        this.#protocolClose();
        return;
      }
      if (!frame.protocols.includes(APP_PROTOCOL)) {
        this.#protocolClose();
        return;
      }
      this.#greeted = true;
      this.#send({
        type: "welcome",
        protocol: APP_PROTOCOL,
        instanceId: this.#welcome.instanceId,
        serverVersion: this.#welcome.serverVersion,
        omp: this.#welcome.omp,
        capabilities: this.#welcome.capabilities,
      });
      return;
    }

    if (frame.type === "hello") {
      this.#protocolClose();
      return;
    }
    if (frame.type === "call") {
      this.#call(frame);
    } else if (frame.type === "cancel") {
      this.#cancel(frame);
    } else if (frame.type === "subscribe") {
      this.#subscribe(frame);
    } else if (frame.type === "unsubscribe") {
      this.#unsubscribe(frame);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#logger?.info("connection.close", {
      id: this.#socket.id.slice(0, 8),
      pending_calls: this.#pending.size,
    });
    for (const pending of this.#pending.values()) pending.controller.abort("connection_closed");
    this.#pending.clear();
    for (const dispose of this.#subscriptions.values()) dispose();
    this.#subscriptions.clear();
    for (const registration of this.#registry.values()) {
      const release = registration.onConnectionClosed;
      if (release === undefined) continue;
      const connectionId = this.#socket.id;
      void Promise.resolve()
        .then(() => release(connectionId))
        .catch((error: unknown) => {
          console.error(
            `[omp-app] ${registration.port.name} could not release a closed connection`,
            error,
          );
        });
    }
    this.#onClose?.();
  }

  #protocolClose(): void {
    this.#sendError(undefined, protocolError());
    this.#socket.close(1002, "Invalid app protocol frame");
    this.close();
  }

  #send(frame: ServerFrame): boolean {
    if (this.#closed) return false;
    try {
      this.#socket.send(frame);
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  #sendResult(id: RequestId, value: unknown): void {
    // A handler with no result (omp's response without data, a void method) still sends `value`:
    // JSON drops undefined keys, and the client's ResultFrame requires the field.
    const frame = ResultFrameSchema.parse({ type: "result", id, ok: true, value: value ?? null });
    this.#send(frame);
  }

  #sendError(id: RequestId | undefined, error: AppError): void {
    if (id === undefined) return;
    const parsed = AppErrorSchema.safeParse(error);
    const appError = parsed.success ? parsed.data : INTERNAL_ERROR;
    this.#send(ResultFrameSchema.parse({ type: "result", id, ok: false, error: appError }));
  }

  #call(frame: Extract<ClientFrame, { type: "call" }>): void {
    const registration = this.#registry.get(frame.port);
    if (registration === undefined) {
      this.#sendError(frame.id, notFound(`Unknown port ${frame.port}`));
      return;
    }
    const method = (
      registration.port.methods as Record<string, { args: z.ZodType; result: z.ZodType }>
    )[frame.method];
    const handler = registration.handlers[frame.method];
    if (method === undefined || handler === undefined) {
      this.#sendError(frame.id, notFound(`Unknown method ${frame.port}.${frame.method}`));
      return;
    }
    if (this.#pending.has(frame.id)) {
      this.#sendError(frame.id, {
        code: "conflict",
        message: "A call with this id is already running",
        retryable: true,
      });
      return;
    }
    const parsedArgs = method.args.safeParse(frame.args);
    if (!parsedArgs.success) {
      this.#sendError(frame.id, invalidArgs(z.prettifyError(parsedArgs.error)));
      return;
    }
    const controller = new AbortController();
    this.#pending.set(frame.id, { controller });
    const label = `${frame.port}.${frame.method}`;
    void this.#runCall(frame.id, label, registration, method, handler, parsedArgs.data, controller);
  }

  async #runCall(
    id: RequestId,
    label: string,
    registration: PortRegistration,
    method: { args: z.ZodType; result: z.ZodType },
    handler: (args: unknown, context: PortHandlerContext) => unknown | Promise<unknown>,
    args: unknown,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await handler(args, {
        signal: controller.signal,
        connectionId: this.#socket.id,
        requestId: id,
        portContext: registration.context,
      });
      if (!this.#pending.has(id)) return;
      this.#pending.delete(id);
      const parsedResult = method.result.safeParse(result);
      if (!parsedResult.success) {
        // A handler that breaks its own result schema is a bug: say which one, never the payload.
        console.error(`[omp-app] ${label} returned a result that fails its schema`);
        this.#logger?.error("port.bad_result", { call: label });
        this.#sendError(id, INTERNAL_ERROR);
        return;
      }
      this.#sendResult(id, parsedResult.data);
    } catch (error) {
      if (!this.#pending.has(id)) return;
      this.#pending.delete(id);
      // AppFailure is an expected, typed outcome; anything else is a bug the client only sees as
      // `internal`, so record it here (method name and error, never the call's arguments).
      if (!(error instanceof AppFailure)) {
        console.error(`[omp-app] ${label} failed`, error);
        // The error text and stack only: never the call's arguments, which hold the user's words.
        this.#logger?.error("port.crash", {
          call: label,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        this.#logger?.warn("port.error", {
          call: label,
          code: error.appError.code,
          omp: error.appError.omp?.code,
          message: error.appError.message,
        });
      }
      this.#sendError(id, appErrorFromUnknown(error));
    }
  }

  #cancel(frame: Extract<ClientFrame, { type: "cancel" }>): void {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    pending.controller.abort("cancelled");
    this.#pending.delete(frame.id);
    this.#sendError(frame.id, CANCELLED_ERROR);
  }

  #subscribe(frame: Extract<ClientFrame, { type: "subscribe" }>): void {
    const payloadSchema = eventSchema(this.#registry, frame.stream);
    if (payloadSchema === undefined) {
      this.#sendError(frame.id, notFound(`Unknown event stream ${frame.stream}`));
      return;
    }
    const replay = this.#replay.replay(frame.stream, frame.afterSeq);
    if ("error" in replay) {
      this.#sendError(frame.id, replay.error);
      return;
    }
    this.#subscriptions.get(frame.stream)?.();
    const dispose = this.#replay.subscribe(frame.stream, (event) => this.#send(event));
    this.#subscriptions.set(frame.stream, dispose);
    for (const event of replay.frames) this.#send(event);
    this.#sendResult(frame.id, { stream: frame.stream });
  }

  #unsubscribe(frame: Extract<ClientFrame, { type: "unsubscribe" }>): void {
    this.#subscriptions.get(frame.stream)?.();
    this.#subscriptions.delete(frame.stream);
    this.#sendResult(frame.id, null);
  }
}

/** Dispatcher composition shared by the HTTP/WebSocket shell and in-memory tests. */
export class Dispatcher {
  readonly #options: DispatcherOptions;
  readonly #sessions = new Set<DispatcherSession>();

  constructor(options: DispatcherOptions) {
    this.#options = options;
  }

  open(socket: DispatcherSocket): DispatcherSession {
    let session: DispatcherSession;
    session = new DispatcherSession(socket, this.#options, () => this.#sessions.delete(session));
    this.#sessions.add(session);
    this.#options.logger?.info("connection.open", {
      id: socket.id.slice(0, 8),
      total: this.#sessions.size,
    });
    return session;
  }

  close(session: DispatcherSession): void {
    session.close();
    this.#sessions.delete(session);
  }

  publish(stream: StreamKey, payload: unknown): ReplayEventFrame {
    const parsedStream = StreamKeySchema.parse(stream);
    const schema = eventSchema(this.#options.registry, parsedStream);
    if (schema === undefined) {
      throw new AppFailure(notFound(`Unknown event stream ${parsedStream}`));
    }
    const parsedPayload = schema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new AppFailure(invalidArgs("Event payload failed its port schema"));
    }
    return this.#options.replay.publish(parsedStream, parsedPayload.data);
  }

  closeAll(): void {
    for (const session of [...this.#sessions]) session.close();
    this.#sessions.clear();
  }
}
