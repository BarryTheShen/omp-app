import { ThreadId } from "@omp-app/contracts";
import { SessionFileStore } from "./store";

/**
 * What the server knows about the chats it runs: whether it holds a chat open, and whether the chat's turn is running.
 * The process registry is this in production.
 */
export interface ServerChats {
  has(threadId: ThreadId): boolean;
  busyOf(threadId: ThreadId): boolean | undefined;
}

/**
 * The session-file store as the server composes it. `dev.ts` and the tests both build it here, so the refusals that
 * depend on the server's own chats are checked where they are wired. Without `serverOwnsSession`, a chat the server
 * holds open reads as not held, and omp writes it back after its file is deleted.
 */
export function createServerSessionFileStore(options: {
  readonly sessionsRoot: string;
  readonly home: string;
  readonly chats: ServerChats;
}): SessionFileStore {
  return new SessionFileStore({
    sessionsRoot: options.sessionsRoot,
    home: options.home,
    serverOwnsSession: (sessionId) => options.chats.has(ThreadId.parse(sessionId)),
    turnOf: (sessionId) => {
      const busy = options.chats.busyOf(ThreadId.parse(sessionId));
      if (busy === undefined) return undefined;
      return busy ? "running" : "idle";
    },
  });
}
