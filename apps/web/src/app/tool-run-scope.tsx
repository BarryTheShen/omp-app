import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { ToolRunActiveContext } from "@/modules/U1/tool-slots";

/**
 * The chat's run state for its tool calls. While the chat's run is active, a call with no result is queued,
 * not finished: omp starts an exclusive call only when its turn comes. Once the run has ended, a call with no
 * result is unrecorded. The run state is R0's own prompt flag, read live, not a timer.
 */
export function ToolRunScope({
  store,
  children,
}: {
  readonly store: OmpRuntimeStore;
  readonly children: ReactNode;
}) {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const streaming = useSyncExternalStore(subscribe, () => store.getSnapshot().prompt.streaming);
  return (
    <ToolRunActiveContext.Provider value={streaming}>{children}</ToolRunActiveContext.Provider>
  );
}
