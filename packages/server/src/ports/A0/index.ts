import type { SessionFilePath, ThreadId } from "@omp-app/contracts";
import type { ChatHostHello } from "@omp-app/contracts/chat-host";
import type { CommandSession } from "../../modules/A1/gateway/command-session";
import type { OmpProcess } from "../../process";
import type { PortRegistration } from "../../registry/ports";
import { createAppPortRegistration } from "./app";
import { type ChatSessionPortRegistration, createChatSessionPortRuntime } from "./chat-session";
import type { A0PortContext, ThreadBootstrap } from "./context";

export * from "./app";
export * from "./chat-session";
export * from "./context";
export * from "./devices";

/**
 * Main's registry composition seam. Add the returned registrations to `createPortRegistry([...])`
 * in `packages/server/src/registry/ports.ts`; no central registry edit belongs in this part.
 */
export interface A0Runtime {
  readonly registrations: readonly PortRegistration[];
  /** The chat's command session for the A1 gateway, from its chat host. */
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
  /** Takes over a chat whose host an earlier server left running (D2), as this server starts (see the chat runtime). */
  adopt(
    process: OmpProcess,
    hello: ChatHostHello,
    options: { readonly restartWhenSettled: boolean },
  ): void;
  /** Notes a chat whose host, on another protocol, was asked to hand it back (D2). */
  handingBack(threadId: ThreadId): void;
}

/** The chat session port on the chat hosts (SDK plan H5.3, the app's runtime since H5.4a) and AppPort. */
export function createA0Runtime(context: A0PortContext): A0Runtime {
  const chat = createChatSessionPortRuntime(context);
  return {
    registrations: [
      {
        port: chat.port,
        handlers: chat.runtime.handlers,
        context: chat.runtime,
        onConnectionClosed: (connectionId) => chat.runtime.releaseConnection(connectionId),
      },
      createAppPortRegistration(context),
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
    adopt: (process, hello, options) => chat.runtime.adopt(process, hello, options),
    handingBack: (threadId) => chat.runtime.handingBack(threadId),
  };
}

export type { A0PortContext, ChatSessionPortRegistration, ThreadBootstrap };
