import type { SessionFilePath, ThreadId, UsagePauseHold } from "@omp-app/contracts";
import type { ChatHostHello } from "@omp-app/contracts/chat-host";
import type { CommandSession } from "../../modules/A1/gateway/command-session";
import type { OmpProcess } from "../../process";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";
import { createAppPortRegistration } from "./app";
import { type ChatSessionPortRegistration, createChatSessionPortRuntime } from "./chat-session";
import type { A0PortContext, ThreadBootstrap } from "./context";

export * from "./app";
export * from "./browser/browser";
export * from "./chat-session";
export * from "./context";
export * from "./devices";
export * from "./running-chats";
export * from "./shares/shares";

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
  /** The chats the app continues after a usage limit, for the chat list (#2781; see the chat runtime). */
  readonly continuing: {
    continuingIn(
      folder: string,
    ): readonly { readonly id: ThreadId; readonly continuesAt: number }[];
    onContinueChange(
      listener: (
        threadId: ThreadId,
        folder: string | undefined,
        continuesAt: number | null,
      ) => void,
    ): () => void;
  };
  /** The chats marked to pause at their usage limit, for the chat list (#2781 part 3; see the chat runtime). */
  readonly usagePauses: {
    usagePausesIn(folder: string): readonly {
      readonly id: ThreadId;
      readonly percent: number;
      readonly hold: UsagePauseHold | null;
    }[];
    onUsagePauseChange(
      listener: (
        threadId: ThreadId,
        folder: string,
        percent: number | null,
        hold: UsagePauseHold | null,
      ) => void,
    ): () => void;
  };
  /** Whether a chat waits for an answer from you, and each change, for the running list (D1; see the chat runtime). */
  readonly waiting: {
    waitingFor(threadId: ThreadId): boolean;
    onWaitingChange(listener: () => void): () => void;
  };
  /** Ends a chat's turn as Esc does, for the running list's Stop (D1; the chat runtime's `abort` request). */
  abortTurn(threadId: ThreadId, call: PortHandlerContext): Promise<unknown>;
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
    continuing: chat.runtime.continuing,
    usagePauses: chat.runtime.usagePauses,
    waiting: chat.runtime.waiting,
    abortTurn: (threadId, call) =>
      chat.runtime.request({ threadId, method: "abort", params: {} }, call),
  };
}

export type { A0PortContext, ChatSessionPortRegistration, ThreadBootstrap };
