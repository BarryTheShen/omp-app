/**
 * The app's own wire between browser and server: protocol `omp-app/1`, one JSON object per
 * frame, every frame validated with the schemas below. Ports (`definePort`) are the only way
 * modules talk across it; A0 builds the server dispatcher and the browser proxy from them.
 *
 * Flow: the client sends `hello`; the server answers `welcome`. Every `call`, `subscribe` and
 * `unsubscribe` carries an `id` and gets exactly one `result` with that id. `cancel` names a
 * running call; that call then ends with an `AppError` of code `cancelled` unless it already
 * finished. Events arrive on streams; each stream numbers its events `seq` = 1, 2, 3, … and a
 * client that reconnects resubscribes with `afterSeq` (the last seq it saw) to receive the rest.
 * Seqs are comparable only within one server `instanceId`; when the instance changed, or the
 * server no longer holds the requested events, `subscribe` fails with code `conflict` and the
 * client refetches state instead of resuming.
 */
import { z } from "zod";
import { type CapabilityKey, CapabilityMap } from "./capabilities";
import { AppError, type ParseResult, parseJson } from "./errors";
import { RequestId } from "./ids";
import { MODULE_IDS, type ModuleId } from "./modules";
import { OMP_PROTOCOL_VERSIONS } from "./omp";

export const APP_PROTOCOL = "omp-app/1";

/** Lower camel case: `listSessions`, `sessionEvent`. */
const MEMBER_NAME = /^[a-z][A-Za-z0-9]*$/;
const PORT_NAME = new RegExp(`^(?:${MODULE_IDS.join("|")})\\.[a-z][A-Za-z0-9]*$`);

/** `<ModuleId>.<name>`, for example `A1.configStore`. The module prefix is the port's owner. */
export type PortName = `${ModuleId}.${string}`;
export const PortName = z.custom<PortName>(
  (value) => typeof value === "string" && PORT_NAME.test(value),
  "expected <ModuleId>.<lowerCamelName>",
);

/**
 * `<port>/<event>` or `<port>/<event>/<scope>`; the scope (a thread id, a folder, …) may contain
 * any characters, including `/`.
 */
export type StreamKey = `${PortName}/${string}`;
export const StreamKey = z.custom<StreamKey>((value) => {
  if (typeof value !== "string") return false;
  const [port, event, ...scope] = value.split("/");
  return (
    port !== undefined &&
    PORT_NAME.test(port) &&
    event !== undefined &&
    MEMBER_NAME.test(event) &&
    (scope.length === 0 || scope.join("/").length > 0)
  );
}, "expected <port>/<event> or <port>/<event>/<scope>");

/** Builds the stream key of one port event, optionally narrowed to a scope. */
export function streamKey(port: PortName, event: string, scope?: string): StreamKey {
  const key = scope === undefined ? `${port}/${event}` : `${port}/${event}/${scope}`;
  return StreamKey.parse(key);
}

const Seq = z.int().min(1);

// Client → server

export const HelloFrame = z.object({
  type: z.literal("hello"),
  /** App protocols the client speaks, most preferred first. */
  protocols: z.array(z.string()).min(1),
  client: z.object({ name: z.string(), version: z.string() }),
});

export const CallFrame = z.object({
  type: z.literal("call"),
  id: RequestId,
  port: PortName,
  method: z.string().regex(MEMBER_NAME),
  /** Validated by the server against the method's `args` schema. */
  args: z.unknown(),
});

export const CancelFrame = z.object({
  type: z.literal("cancel"),
  /** The `id` of the running call to cancel. */
  id: RequestId,
});

export const SubscribeFrame = z.object({
  type: z.literal("subscribe"),
  id: RequestId,
  stream: StreamKey,
  /** Resume after this seq; omitted for a fresh subscription that starts with new events. */
  afterSeq: z.int().min(0).optional(),
});

export const UnsubscribeFrame = z.object({
  type: z.literal("unsubscribe"),
  id: RequestId,
  stream: StreamKey,
});

export const ClientFrame = z.discriminatedUnion("type", [
  HelloFrame,
  CallFrame,
  CancelFrame,
  SubscribeFrame,
  UnsubscribeFrame,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// Server → client

export const WelcomeFrame = z.object({
  type: z.literal("welcome"),
  /** The app protocol chosen from `hello.protocols`. */
  protocol: z.literal(APP_PROTOCOL),
  /** Changes whenever the server process restarts; stream seqs restart with it. */
  instanceId: z.string().min(1),
  serverVersion: z.string(),
  /** The omp the server runs and the RPC protocol it negotiates with it; null without omp. */
  omp: z
    .object({
      version: z.string(),
      protocolVersion: z.union(OMP_PROTOCOL_VERSIONS.map((version) => z.literal(version))),
    })
    .nullable(),
  capabilities: CapabilityMap,
});

export const ResultFrame = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("result"), id: RequestId, ok: z.literal(true), value: z.unknown() }),
  z.object({ type: z.literal("result"), id: RequestId, ok: z.literal(false), error: AppError }),
]);

export const EventFrame = z.object({
  type: z.literal("event"),
  stream: StreamKey,
  seq: Seq,
  /** Validated by the client against the port event's `payload` schema. */
  payload: z.unknown(),
});

export const ServerFrame = z.union([WelcomeFrame, ResultFrame, EventFrame]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export function parseClientFrame(text: string): ParseResult<ClientFrame> {
  return parseJson(ClientFrame, text);
}

export function parseServerFrame(text: string): ParseResult<ServerFrame> {
  return parseJson(ServerFrame, text);
}

/** Validates a frame and returns its JSON text; throws on a frame that breaks the schema. */
export function serializeFrame(frame: ClientFrame | ServerFrame): string {
  const fromServer = frame.type === "welcome" || frame.type === "result" || frame.type === "event";
  return JSON.stringify(fromServer ? ServerFrame.parse(frame) : ClientFrame.parse(frame));
}

// Ports

export interface PortMethod<
  Args extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
> {
  readonly args: Args;
  readonly result: Result;
  /** Without this capability the method fails with `unavailable` and its controls are gated. */
  readonly capability?: CapabilityKey;
}

export interface PortEvent<Payload extends z.ZodType = z.ZodType> {
  readonly payload: Payload;
  readonly capability?: CapabilityKey;
}

export interface Port<
  Name extends PortName = PortName,
  Methods extends Record<string, PortMethod> = Record<string, PortMethod>,
  Events extends Record<string, PortEvent> = Record<string, PortEvent>,
> {
  readonly name: Name;
  readonly methods: Methods;
  readonly events: Events;
}

/**
 * Declares a port: a name, its methods (args schema, result schema, required capability) and
 * its events. Throws when a name breaks the naming rules, so a bad port fails at import time.
 */
export function definePort<
  const Name extends PortName,
  const Methods extends Record<string, PortMethod>,
  const Events extends Record<string, PortEvent>,
>(port: Port<Name, Methods, Events>): Port<Name, Methods, Events> {
  PortName.parse(port.name);
  for (const member of [...Object.keys(port.methods), ...Object.keys(port.events)]) {
    if (!MEMBER_NAME.test(member)) {
      throw new Error(`Port ${port.name}: member "${member}" is not lowerCamelCase`);
    }
  }
  return Object.freeze({ ...port });
}

/**
 * The part of an `AbortSignal` a port client uses, declared structurally so this package needs
 * no DOM or Bun types; the `signal` of a real `AbortController` satisfies it.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Per-call options of a port client method. */
export interface PortCallOptions {
  /**
   * Aborting it sends a `cancel` frame for the call, and the promise rejects at once with an
   * `AppError` of code `cancelled` (`retryable: false`); a `result` that still arrives for the
   * call is ignored. A signal that is already aborted rejects the same way without sending the
   * call. Cancelling does not undo work the server already finished; a caller that must know
   * refetches.
   */
  readonly signal?: AbortSignalLike;
}

/** What the browser proxy of a port looks like: one async function per method. */
export type PortClient<P extends Port> = {
  readonly [M in keyof P["methods"]]: (
    args: z.input<P["methods"][M]["args"]>,
    options?: PortCallOptions,
  ) => Promise<z.output<P["methods"][M]["result"]>>;
};

/** What the server implements for a port: one handler per method, given validated args. */
export type PortHandlers<P extends Port, Context> = {
  readonly [M in keyof P["methods"]]: (
    args: z.output<P["methods"][M]["args"]>,
    context: Context,
  ) => Promise<z.input<P["methods"][M]["result"]>>;
};

export type PortEventPayload<P extends Port, E extends keyof P["events"]> = z.output<
  P["events"][E]["payload"]
>;
