import type { AppClient } from "@omp-app/client";
import {
  type OmpWire,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { CompactionControls, ContextMeter } from "@/modules/P7/context";
import {
  type CompactionPort,
  type CompactionState,
  type CompactionStateSource,
  createCompactionPort,
  createContextUsagePort,
  type SessionContextSource,
} from "@/modules/P7/contract";
import type { OmpRuntimeStore } from "@/modules/R0/store";

/**
 * The compaction state the panel shows, from R0's copy of `get_state`. R0 reports whether a compaction
 * is running and whether auto-compaction is on. It keeps no compaction result; the result of a
 * compaction this panel ran is added by `compactionSourceFor`.
 */
export function compactionStateOf(store: OmpRuntimeStore): CompactionState {
  const session = store.getSnapshot().session;
  return {
    phase: session.isCompacting ? "running" : "idle",
    method: null,
    auto: session.autoCompactionEnabled === true,
    result: null,
    error: null,
    revision: `session-${session.revision}`,
  };
}

/** The compaction source, and the way to record the result of a compaction the panel ran. */
interface CompactionSource {
  readonly source: CompactionStateSource;
  readonly recordResult: (result: OmpWire.CompactionResult) => void;
}

/**
 * A compaction source whose snapshot changes only when the state does. A successful compaction shows as
 * completed with its result until the next one starts. The panel reads the source through
 * `useSyncExternalStore`, which needs the same object back until something changed.
 */
function compactionSourceFor(store: OmpRuntimeStore): CompactionSource {
  let lastResult: OmpWire.CompactionResult | null = null;
  let cached: CompactionState | undefined;
  const listeners = new Set<(snapshot: CompactionState) => void>();
  const current = (): CompactionState => {
    const base = compactionStateOf(store);
    const next: CompactionState =
      lastResult === null || base.phase === "running"
        ? base
        : { ...base, phase: "completed", result: lastResult };
    const same =
      cached !== undefined &&
      cached.revision === next.revision &&
      cached.phase === next.phase &&
      cached.auto === next.auto &&
      cached.result === next.result;
    if (!same) cached = next;
    return cached ?? next;
  };
  return {
    source: {
      getSnapshot: current,
      subscribe: (listener) => {
        listeners.add(listener);
        const unsubscribe = store.subscribe(() => listener(current()));
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    },
    recordResult: (result) => {
      lastResult = result;
      const snapshot = current();
      for (const listener of listeners) listener(snapshot);
    },
  };
}

/** Reads omp's state again after a change, so the store shows what omp now reports. */
async function refreshSession(
  client: AppClient,
  store: OmpRuntimeStore,
  threadId: ThreadId,
): Promise<void> {
  const session = client.port(RpcSessionPort) as RpcSessionClient;
  await session
    .send({ threadId, command: { type: "get_state" } })
    .then((state) => store.applySessionState(state));
}

/** The compaction port: the result of an accepted compaction is recorded, and the session read again. */
function compactionPortFor(
  compaction: CompactionSource,
  store: OmpRuntimeStore,
  client: AppClient,
  threadId: ThreadId,
): CompactionPort {
  const base = createCompactionPort(compaction.source, client, threadId);
  return {
    getSnapshot: base.getSnapshot,
    subscribe: base.subscribe,
    compact: async (request, options) => {
      const result = await base.compact(request, options);
      compaction.recordResult(result);
      await refreshSession(client, store, threadId);
      return result;
    },
    setAutoCompaction: async (request, options) => {
      await base.setAutoCompaction(request, options);
      await refreshSession(client, store, threadId);
    },
  };
}

function contextProjection(store: OmpRuntimeStore, threadId: ThreadId) {
  const session = store.getSnapshot().session;
  return {
    threadId,
    ...(session.contextUsage ? { contextUsage: session.contextUsage } : {}),
    isCompacting: session.isCompacting,
    ...(session.autoCompactionEnabled === null
      ? {}
      : { autoCompactionEnabled: session.autoCompactionEnabled }),
    tokensPerSecond: session.tokensPerSecond,
    revision: `session-${session.revision}`,
  };
}

/**
 * The right-hand Context panel for the open chat. Its surface requires the get_state, compact and
 * set_auto_compaction capabilities, so a host without them does not list it. The compaction controls
 * wait until omp reports the auto-compaction setting, so the panel never shows a setting it does not
 * know.
 */
export function SessionContextPanel({
  client,
  store,
  threadId,
}: {
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
}) {
  const autoCompactionKnown = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot().session.autoCompactionEnabled !== null,
    () => store.getSnapshot().session.autoCompactionEnabled !== null,
  );
  const ports = useMemo(() => {
    const contextSource: SessionContextSource = {
      getSnapshot: () => contextProjection(store, threadId),
      subscribe: (listener) => store.subscribe(() => listener(contextProjection(store, threadId))),
    };
    return {
      context: createContextUsagePort(contextSource),
      compaction: compactionPortFor(compactionSourceFor(store), store, client, threadId),
    };
  }, [client, store, threadId]);
  return (
    <div className="flex flex-col gap-4 p-3">
      <ContextMeter port={ports.context} />
      {autoCompactionKnown ? <CompactionControls port={ports.compaction} /> : null}
    </div>
  );
}
