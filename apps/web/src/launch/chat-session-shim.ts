/**
 * The cutover's shim (SDK plan H5.4a, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.4 design"). The browser's readers still
 * speak A0's RPC port, while the server serves the chat session port. This client serves A0's RPC port from
 * `A0.chatSession`, with R0's translation (`modules/R0/store/rpc-frames.ts`): each session payload becomes one RPC event,
 * sends become requests by method, and the RPC answers of host tools and URIs become `answer`. The host's dialogs are
 * answered on the chat session port itself since H5.4c, so the RPC port's dialog methods are refused here. Every other
 * port passes through. The later H5.4 parts move the readers off it, and H5.4h deletes it.
 */
import {
  type AppClient,
  type AppClientSubscription,
  type CreateAppClientOptions,
  createAppClient,
  type SubscribeOptions,
} from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type CapabilityMap,
  type ChatSessionEvent,
  ChatSessionPort,
  type PortCallOptions,
  type PortClient,
  type RpcSessionEvent,
  RpcSessionPort,
} from "@omp-app/contracts";
import {
  requestOf,
  resultOf,
  rpcEventOf,
  toolAnswerOf,
  uriAnswerOf,
} from "../modules/R0/store/rpc-frames";

type RpcSessionClient = PortClient<typeof RpcSessionPort>;
type ChatSessionClient = PortClient<typeof ChatSessionPort>;

/** The RPC port's dialog methods: the dialogs are answered and replayed on the chat session port (H5.4c). */
function dialogsMoved(method: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: `omp's questions are answered on the chat session port; ${method} is not served here.`,
    retryable: false,
  });
}

/** A0's RPC port, served by the chat session port. */
function rpcSessionClientOver(
  chat: ChatSessionClient,
  capabilities: () => Promise<CapabilityMap>,
): RpcSessionClient {
  const rpc: RpcSessionClient = {
    open: async (args, options) => {
      const opened = await chat.open(args, options);
      return {
        threadId: opened.threadId,
        sessionFile: opened.sessionFile,
        capabilities: await capabilities(),
      };
    },
    rename: (args, options) => chat.rename(args, options),
    send: async (args, options?: PortCallOptions) => {
      const { method, params } = requestOf(args.command as unknown as Record<string, unknown>);
      const result = await chat.request(
        {
          threadId: args.threadId,
          method,
          params,
          ...(args.registrationOwner === undefined
            ? {}
            : { registrationOwner: args.registrationOwner }),
        } as Parameters<ChatSessionClient["request"]>[0],
        options,
      );
      return resultOf(method, result) as Awaited<ReturnType<RpcSessionClient["send"]>>;
    },
    subscribe: (args, options) => chat.subscribe(args, options),
    answerExtensionUi: async () => {
      throw dialogsMoved("answerExtensionUi");
    },
    openQuestions: async () => {
      throw dialogsMoved("openQuestions");
    },
    stateFrames: async () => {
      throw dialogsMoved("stateFrames");
    },
    answerHostTool: async ({ threadId, response }, options) => {
      if (response.type === "host_tool_update") {
        await chat.request(
          {
            threadId,
            method: "host_tool_update",
            params: { callId: response.id, partialResult: response.partialResult },
          } as Parameters<ChatSessionClient["request"]>[0],
          options,
        );
        return null;
      }
      return chat.answer({ threadId, id: response.id, answer: toolAnswerOf(response) }, options);
    },
    answerHostUri: ({ threadId, response }, options) =>
      chat.answer({ threadId, id: response.id, answer: uriAnswerOf(response) }, options),
    setSubagentSubscription: (args, options) => chat.setSubagentSubscription(args, options),
    setEventFilter: async () => {
      throw new AppFailure({
        code: "unavailable",
        message: "The chat host sends every event; there is no event filter to set.",
        retryable: false,
      });
    },
    restart: (args, options) => chat.restart(args, options),
    close: (args, options) => chat.close(args, options),
  };
  return rpc;
}

type RpcListener = (event: RpcSessionEvent, seq: number) => void;
type ChatListener = (payload: ChatSessionEvent, seq: number) => void;

/**
 * The connection's client, with A0's RPC port served by the chat session port. A listener is wrapped once, so passing the
 * same function in `onEvent` and to `subscription.onEvent` still attaches it once, as the client promises.
 */
export function withChatSessionShim(client: AppClient): AppClient {
  let capabilities: Promise<CapabilityMap> | undefined;
  const readCapabilities = (): Promise<CapabilityMap> => {
    capabilities ??= client
      .port(AppPort)
      .capabilities({})
      .catch((error: unknown) => {
        capabilities = undefined;
        throw error;
      });
    return capabilities;
  };
  const rpc = rpcSessionClientOver(client.port(ChatSessionPort), readCapabilities);
  const isRpcPort = (port: { readonly name: string }): boolean => port.name === RpcSessionPort.name;

  return {
    get connectionState() {
      return client.connectionState;
    },
    get instanceId() {
      return client.instanceId;
    },
    onConnectionState: (listener) => client.onConnectionState(listener),
    onResync: (listener) => client.onResync(listener),
    port: ((port) => (isRpcPort(port) ? rpc : client.port(port))) as AppClient["port"],
    subscribe: (async (port, event, options) => {
      if (!isRpcPort(port)) return client.subscribe(port, event, options);
      const wrapped = new WeakMap<RpcListener, ChatListener>();
      const wrap = (listener: RpcListener): ChatListener => {
        let chatListener = wrapped.get(listener);
        if (chatListener === undefined) {
          chatListener = (payload, seq) => listener(rpcEventOf(payload, seq), seq);
          wrapped.set(listener, chatListener);
        }
        return chatListener;
      };
      const rpcOptions = options as SubscribeOptions<RpcSessionEvent> | undefined;
      const subscription = await client.subscribe(ChatSessionPort, "event", {
        ...(rpcOptions?.scope === undefined ? {} : { scope: rpcOptions.scope }),
        ...(rpcOptions?.afterSeq === undefined ? {} : { afterSeq: rpcOptions.afterSeq }),
        ...(rpcOptions?.signal === undefined ? {} : { signal: rpcOptions.signal }),
        ...(rpcOptions?.onEvent === undefined ? {} : { onEvent: wrap(rpcOptions.onEvent) }),
      });
      const shimmed: AppClientSubscription<RpcSessionEvent> = {
        stream: subscription.stream,
        get lastSeq() {
          return subscription.lastSeq;
        },
        onEvent: (listener) => subscription.onEvent(wrap(listener)),
        unsubscribe: () => subscription.unsubscribe(),
      };
      return shimmed;
    }) as AppClient["subscribe"],
    dispose: () => client.dispose(),
  };
}

/** The app's client: `createAppClient`, with the cutover's shim. */
export function createChatSessionAppClient(options: CreateAppClientOptions): AppClient {
  return withChatSessionShim(createAppClient(options));
}
