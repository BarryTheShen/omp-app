import type { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { type CommandSession, rpcCommandSession } from "../../modules/A1/gateway/command-session";
import type { PortRegistration } from "../../registry/ports";
import { createAppPortRegistration } from "./app";
import { type ChatSessionPortRegistration, createChatSessionPortRuntime } from "./chat-session";
import {
  type A0PortContext,
  createRpcSessionPortRuntime,
  type RpcSessionPortRegistration,
  type ThreadBootstrap,
} from "./rpc-session";

export * from "./app";
export * from "./chat-session";
export * from "./rpc-session";

/**
 * Main's registry composition seam. Add the returned registrations to `createPortRegistry([...])`
 * in `packages/server/src/registry/ports.ts`; no central registry edit belongs in this part.
 */
export interface A0Runtime {
  readonly registrations: readonly PortRegistration[];
  /** The chat's command session for the A1 gateway: from the chat host (`chatHost`), or from omp's RPC. */
  commandSessionFor(threadId: ThreadId): CommandSession | undefined;
  sessionFileOf(threadId: ThreadId): SessionFilePath | undefined;
  /**
   * The views each connection holds on the chats this runtime runs. A delete of a chat counts them; omp's exit takes the
   * views of a chat with it, since its entry goes.
   */
  readonly views: {
    viewsOf(threadId: ThreadId, connectionId: string): number;
    watcherCount(threadId: ThreadId): number;
    releaseViews(threadId: ThreadId, connectionId: string): Promise<void>;
    /** Gives the connection back the views a delete's stop took, joined to the chat's running omp (see the rpc runtime). */
    restoreViews(threadId: ThreadId, connectionId: string, count: number): void;
  };
}

export interface A0RuntimeOptions {
  /**
   * Chats on the chat host's own protocol (SDK plan H5.3), as the app runs them since H5.4a: the chat session port
   * replaces the RPC one, and the registry's processes must run the chat host's `chat` command. Without it, the RPC
   * runtime serves, for its own tests until H5.6 deletes it.
   */
  readonly chatHost?: boolean;
}

export function createA0Runtime(context: A0PortContext, options: A0RuntimeOptions = {}): A0Runtime {
  const app = createAppPortRegistration(context);
  if (options.chatHost === true) {
    const chat = createChatSessionPortRuntime(context);
    return {
      registrations: [
        {
          port: chat.port,
          handlers: chat.runtime.handlers,
          context: chat.runtime,
          onConnectionClosed: (connectionId) => chat.runtime.releaseConnection(connectionId),
        },
        app,
      ],
      commandSessionFor: (threadId) => chat.runtime.commandSessionFor(threadId),
      sessionFileOf: (threadId) => chat.runtime.sessionFileOf(threadId),
      views: {
        viewsOf: (threadId, connectionId) => chat.runtime.viewsOf(threadId, connectionId),
        watcherCount: (threadId) => chat.runtime.watcherCount(threadId),
        releaseViews: (threadId, connectionId) => chat.runtime.releaseViews(threadId, connectionId),
        restoreViews: (threadId, connectionId, count) =>
          chat.runtime.restoreViews(threadId, connectionId, count),
      },
    };
  }
  const rpc = createRpcSessionPortRuntime(context);
  return {
    registrations: [
      {
        port: rpc.port,
        handlers: rpc.runtime.handlers,
        context: rpc.runtime,
        onConnectionClosed: (connectionId) => rpc.runtime.releaseConnection(connectionId),
      },
      app,
    ],
    commandSessionFor: (threadId) => {
      const session = rpc.runtime.sessionFor(threadId);
      return session === undefined ? undefined : rpcCommandSession(session);
    },
    sessionFileOf: (threadId) => rpc.runtime.sessionFileOf(threadId),
    views: {
      viewsOf: (threadId, connectionId) => rpc.runtime.viewsOf(threadId, connectionId),
      watcherCount: (threadId) => rpc.runtime.watcherCount(threadId),
      releaseViews: (threadId, connectionId) => rpc.runtime.releaseViews(threadId, connectionId),
      restoreViews: (threadId, connectionId, count) =>
        rpc.runtime.restoreViews(threadId, connectionId, count),
    },
  };
}

export function createA0PortRegistrations(context: A0PortContext): readonly PortRegistration[] {
  return createA0Runtime(context).registrations;
}

export type {
  A0PortContext,
  ChatSessionPortRegistration,
  RpcSessionPortRegistration,
  ThreadBootstrap,
};
