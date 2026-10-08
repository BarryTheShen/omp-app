import type { AppError, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeSnapshot } from "@/modules/P4/contract";
import type { OmpSessionTreePort } from "@/modules/P4/history";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { isStreaming, transcriptEntryCount, treeLoadError } from "./rewind-tree";

export interface RewindTreeState {
  readonly snapshot: TreeSnapshot | null;
  readonly error: AppError | null;
  readonly isLoading: boolean;
  readonly reload: () => void;
}

/**
 * omp's session tree for the selected conversation. It is read when the panel opens, and again when
 * the conversation's entries change; a reply that is still streaming waits for its end, because the
 * tree does not change until the reply is written.
 */
export function useRewindTree(
  port: OmpSessionTreePort,
  threadId: ThreadId,
  store: OmpRuntimeStore,
): RewindTreeState {
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const latest = useRef(0);
  const loadedEntries = useRef<number | null>(null);

  const load = useCallback(() => {
    const request = latest.current + 1;
    latest.current = request;
    setIsLoading(true);
    setError(null);
    port.readTree(threadId).then(
      (next) => {
        if (latest.current !== request) return;
        loadedEntries.current = transcriptEntryCount(store);
        setSnapshot(next);
        setIsLoading(false);
      },
      (failure: unknown) => {
        if (latest.current !== request) return;
        setError(treeLoadError(failure));
        setIsLoading(false);
      },
    );
  }, [port, store, threadId]);

  useEffect(() => {
    load();
    return () => {
      // A read still in flight belongs to a conversation or port that is no longer shown.
      latest.current += 1;
    };
  }, [load]);

  useEffect(
    () =>
      store.subscribe(() => {
        if (isStreaming(store) || transcriptEntryCount(store) === loadedEntries.current) return;
        load();
      }),
    [load, store],
  );

  return { snapshot, error, isLoading, reload: load };
}
