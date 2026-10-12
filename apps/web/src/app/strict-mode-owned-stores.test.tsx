import { ThreadId } from "@omp-app/contracts";
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect, useMemo } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionInfoMetadataSource, SessionInfoRuntimeSource } from "@/modules/D5/contract";
import type { SessionInfoModel } from "@/modules/D5/session/info";
import { OmpRuntimeStore } from "@/modules/R0/store";
import type { TodoPhase } from "@/modules/U5/todo/contract";
import type { TodoStoreAdapter } from "@/modules/U5/todo/store/store";
import { useChatSessionInfo, useChatTodoStore } from "./owned-stores";

afterEach(cleanup);

const chat = ThreadId.parse("strict-owned-chat");
const otherChat = ThreadId.parse("strict-owned-other-chat");
const phases: TodoPhase[] = [
  { name: "Build", tasks: [{ content: "compile", status: "in_progress" }] },
];

interface ChatStores {
  readonly sessionInfo: SessionInfoModel;
  readonly todoStore: TodoStoreAdapter;
}

/** No session catalog entry: in these tests the chat's title comes from the runtime's session name. */
const noMetadata: SessionInfoMetadataSource = {
  getSnapshot: () => null,
  subscribe: () => () => undefined,
};

/**
 * Owns a chat's session info and todo store with the hooks the app root's ActiveThreadReady calls, so these tests run
 * the code the app runs under StrictMode.
 */
function ChatOwner({
  threadId,
  store,
  built,
}: {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly built: { current?: ChatStores };
}) {
  const runtime = useMemo<SessionInfoRuntimeSource>(
    () => ({
      getSnapshot: () => ({ threadId, session: store.getSnapshot().session }),
      subscribe: (listener) => store.subscribe(listener),
    }),
    [store, threadId],
  );
  const sessionInfo = useChatSessionInfo(runtime, noMetadata);
  const todoStore = useChatTodoStore(store);
  useEffect(() => {
    built.current = { sessionInfo, todoStore };
  }, [built, sessionInfo, todoStore]);
  return null;
}

function mountChat(threadId: ThreadId, store: OmpRuntimeStore) {
  const built: { current?: ChatStores } = {};
  const view = render(
    <StrictMode>
      <ChatOwner threadId={threadId} store={store} built={built} />
    </StrictMode>,
  );
  return { view, built };
}

function storesOf(built: { current?: ChatStores }): ChatStores {
  if (built.current === undefined) throw new Error("the chat's stores were not built");
  return built.current;
}

/** Lets the microtask that disposes a replaced or unmounted owner's objects run. */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

describe("chat stores under StrictMode", () => {
  test("session info still reads and follows the chat after StrictMode's simulated remount", () => {
    const store = new OmpRuntimeStore({ threadId: chat });
    const { built } = mountChat(chat, store);
    const { sessionInfo } = storesOf(built);
    expect(sessionInfo.getSnapshot().id).toBe(chat);
    const heard = vi.fn();
    sessionInfo.subscribe(heard);
    store.applySessionState({ sessionName: "Renamed after mount" });
    expect(heard).toHaveBeenCalled();
    expect(sessionInfo.getSnapshot().title).toBe("Renamed after mount");
  });

  test("the todo store still follows the chat after StrictMode's simulated remount", () => {
    const store = new OmpRuntimeStore({ threadId: chat });
    const { built } = mountChat(chat, store);
    const { todoStore } = storesOf(built);
    store.applySessionState({ todoPhases: phases });
    expect(todoStore.getSnapshot().phases).toEqual(phases);
  });

  test("unmounting disposes both: session info refuses reads and the todo store stops following", async () => {
    const store = new OmpRuntimeStore({ threadId: chat });
    const { view, built } = mountChat(chat, store);
    const { sessionInfo, todoStore } = storesOf(built);
    view.unmount();
    await settle();
    expect(() => sessionInfo.getSnapshot()).toThrow("SessionInfoModel has been disposed");
    store.applySessionState({ todoPhases: phases });
    expect(todoStore.getSnapshot().phases).toEqual([]);
  });

  test("a new chat disposes the old objects, and the new ones keep working", async () => {
    const first = new OmpRuntimeStore({ threadId: chat });
    const second = new OmpRuntimeStore({ threadId: otherChat });
    const { view, built } = mountChat(chat, first);
    const old = storesOf(built);
    view.rerender(
      <StrictMode>
        <ChatOwner threadId={otherChat} store={second} built={built} />
      </StrictMode>,
    );
    await settle();
    expect(() => old.sessionInfo.getSnapshot()).toThrow("SessionInfoModel has been disposed");
    second.applySessionState({ sessionName: "New chat", todoPhases: phases });
    expect(storesOf(built).sessionInfo.getSnapshot().id).toBe(otherChat);
    expect(storesOf(built).todoStore.getSnapshot().phases).toEqual(phases);
  });
});
