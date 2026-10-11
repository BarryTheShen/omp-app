import {
  AssistantRuntimeProvider,
  ReadonlyThreadProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { TurnCancelContext } from "@/modules/U1/thread";

/**
 * The inert store assistant-ui's own read-only host (CloudRendererHost) uses: no messages of its own,
 * a disabled composer and no send. It exists only so the library's thread primitives find the thread
 * scopes they need.
 */
const INERT_THREAD_STORE = {
  messages: [] as ThreadMessage[],
  isDisabled: true,
  onNew: async () => {},
};

/**
 * A read-only thread around `messages`: the library's viewport and scroll state work on it, and nothing
 * in it can send, edit, branch or stop the chat's turn. The runtime is its own, so the host app's thread does
 * not leak in.
 */
export function ReadOnlyThread({
  messages,
  children,
}: {
  readonly messages: readonly ThreadMessage[];
  readonly children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessage>(INERT_THREAD_STORE);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ReadonlyThreadProvider messages={messages}>
        <TurnCancelContext.Provider value={undefined}>{children}</TurnCancelContext.Provider>
      </ReadonlyThreadProvider>
    </AssistantRuntimeProvider>
  );
}
