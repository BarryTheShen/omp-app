import { useMemo } from "react";
import type { SessionInfoMetadataSource, SessionInfoRuntimeSource } from "@/modules/D5/contract";
import { SessionInfoModel } from "@/modules/D5/session/info";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useDisposeWhenReplaced } from "@/modules/U4/host";
import { TodoStoreAdapter } from "@/modules/U5/todo/store/store";

/**
 * A chat's session info model, disposed when the chat is replaced or the component that owns it unmounts. The
 * dispose is queued through `useDisposeWhenReplaced`, not run in an effect's own cleanup: StrictMode runs that cleanup
 * and then the effect again with the same model, and a model disposed there throws on read.
 */
export function useChatSessionInfo(
  runtime: SessionInfoRuntimeSource,
  metadata: SessionInfoMetadataSource,
): SessionInfoModel {
  const sessionInfo = useMemo(
    () => new SessionInfoModel({ runtime, metadata }),
    [metadata, runtime],
  );
  useDisposeWhenReplaced(sessionInfo);
  return sessionInfo;
}

/**
 * A chat's todo store, disposed the same way. A disposed store stops following the chat, so disposing it in an
 * effect's cleanup would leave the todo list stuck at empty after StrictMode's remount.
 */
export function useChatTodoStore(store: OmpRuntimeStore): TodoStoreAdapter {
  const todoStore = useMemo(() => new TodoStoreAdapter({ store }), [store]);
  useDisposeWhenReplaced(todoStore);
  return todoStore;
}
