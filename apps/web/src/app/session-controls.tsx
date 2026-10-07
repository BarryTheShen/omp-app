import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, RpcSessionClient, ThreadId } from "@omp-app/contracts";
import { RpcSessionPort } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ThinkingLevel } from "@/modules/D1/contract";
import {
  createR0LiveModelState,
  createRpcModelCatalogSource,
  ModelCatalogModel,
  ModelPicker,
} from "@/modules/D1/model";
import {
  createRpcThinkingSource,
  type LiveThinkingState,
  ThinkingLevelsController,
  ThinkingSelector,
  thinkingLevelLabel,
} from "@/modules/D1/thinking";
import { ContextStatusBar } from "@/modules/P7/context/status-bar";
import {
  createContextUsagePort,
  createUsagePort,
  type SessionContextSource,
  type UsageStateSource,
} from "@/modules/P7/contract";
import type { OmpRuntimeStore, SessionInfoState } from "@/modules/R0/store";
import { useOverlayHost } from "@/overlay";
import { reportClientError } from "./client-errors";

interface SessionControlProps {
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
}

function useSessionInfo(store: OmpRuntimeStore): SessionInfoState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot().session,
    () => store.getSnapshot().session,
  );
}

/** D1 reads the live model and thinking level from R0's copy of `get_state`. */
function liveThinking(store: OmpRuntimeStore): LiveThinkingState {
  const read = () => {
    const session = store.getSnapshot().session;
    const level = ThinkingLevel.safeParse(session.thinkingLevel);
    return {
      current: level.success ? level.data : null,
      configured: null,
      reasoning: session.model?.reasoning ?? true,
    };
  };
  return { getSnapshot: read, subscribe: (listener) => store.subscribe(() => listener(read())) };
}

/**
 * The header's model button: names the session's model and thinking level and opens D1's model
 * picker and thinking selector for this session.
 */
export function SessionModelControl({
  client,
  store,
  threadId,
  capabilities,
}: SessionControlProps) {
  const overlay = useOverlayHost();
  const session = useSessionInfo(store);
  const catalog = useMemo(
    () =>
      new ModelCatalogModel({
        source: createRpcModelCatalogSource(client, threadId),
        capabilities,
        liveState: createR0LiveModelState({
          getSnapshot: () => ({ model: store.getSnapshot().session.model }),
          subscribe: (listener) => store.subscribe(() => listener()),
        }),
      }),
    [capabilities, client, store, threadId],
  );
  const thinking = useMemo(
    () =>
      new ThinkingLevelsController({
        source: createRpcThinkingSource(client, threadId),
        capabilities,
        live: liveThinking(store),
      }),
    [capabilities, client, store, threadId],
  );
  useEffect(() => () => catalog.dispose(), [catalog]);
  useEffect(() => () => thinking.dispose(), [thinking]);
  const rpc = useMemo(() => client.port(RpcSessionPort) as RpcSessionClient, [client]);
  /**
   * The header reads R0's copy of omp's state, which is read again at a turn's end. After the person
   * changes the model or the thinking level, read it now so the header shows what omp uses.
   */
  const refreshSession = useCallback(() => {
    void rpc
      .send({ threadId, command: { type: "get_state" } })
      .then((state) => store.applySessionState(state))
      .catch((error: unknown) => {
        reportClientError({
          kind: "error",
          message: `The session state could not be read after a change: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      });
  }, [rpc, store, threadId]);
  const modelName = session.model?.name ?? session.model?.id;
  const parsedLevel = session.model?.reasoning
    ? ThinkingLevel.safeParse(session.thinkingLevel)
    : null;
  const level =
    parsedLevel?.success && parsedLevel.data !== "off"
      ? thinkingLevelLabel(parsedLevel.data).toLowerCase()
      : null;
  const open = () => {
    void catalog.refresh().catch(() => undefined);
    overlay.open({
      kind: "modal",
      label: "Model and thinking",
      // One size rule, no breakpoints: nearly the whole window when it is small, a roomy 48 by
      // 52rem box when it is large. The content sets no width of its own, so it can never be
      // wider than this frame (it used to ask for 36rem inside a 32rem frame and was cut off).
      className:
        "h-[min(calc(100dvh-1rem),52rem)] w-[min(calc(100vw-1rem),48rem)] max-h-none max-w-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
      content: ({ close }) => (
        <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
          <ModelPicker catalog={catalog} fill onApplied={refreshSession} scope="session" />
          <ThinkingSelector controller={thinking} onApplied={refreshSession} />
          <Button className="self-end" onClick={() => close()} type="button" variant="outline">
            Done
          </Button>
        </div>
      ),
    });
  };
  return (
    <Button
      aria-label={modelName ? `Model: ${modelName}. Change model or thinking` : "Choose a model"}
      className="max-w-64 min-w-0"
      onClick={open}
      size="sm"
      type="button"
      variant="outline"
    >
      <span className="truncate">{modelName ?? "Choose a model"}</span>
      {level ? <span className="text-muted-foreground shrink-0">· {level}</span> : null}
    </Button>
  );
}

/** The status bar's context meter and usage, from R0's copy of `get_state` and `get_session_stats`. */
export function SessionStatusBar({
  client,
  store,
  threadId,
}: Omit<SessionControlProps, "capabilities">) {
  const ports = useMemo(() => {
    const contextSource: SessionContextSource = {
      getSnapshot: () => projection(store, threadId),
      subscribe: (listener) => store.subscribe(() => listener(projection(store, threadId))),
    };
    const usageSnapshot = {
      sessionId: String(threadId),
      status: "idle" as const,
      totals: null,
      contextUsage: null,
      tokenRate: null,
      lastTurn: null,
      revision: "initial",
      error: null,
    };
    const usageSource: UsageStateSource = {
      getSnapshot: () => usageSnapshot,
      subscribe: () => () => undefined,
    };
    return {
      context: createContextUsagePort(contextSource),
      usage: createUsagePort(usageSource, client, threadId),
    };
  }, [client, store, threadId]);
  return <ContextStatusBar context={ports.context} usage={ports.usage} />;
}

function projection(store: OmpRuntimeStore, threadId: ThreadId) {
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
