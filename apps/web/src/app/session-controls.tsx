import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, FolderPath, RpcSessionClient, ThreadId } from "@omp-app/contracts";
import { RpcSessionPort } from "@omp-app/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ThinkingLevel } from "@/modules/D1/contract";
import { ModelHubController, ModelHubPanel, openHubRoles } from "@/modules/D1/hub";
import {
  createConfigRecentModelsPort,
  createR0LiveModelState,
  createRpcModelCatalogSource,
  ModelCatalogModel,
  RecentModels,
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
  createUsageLimitsSource,
  createUsagePort,
  type SessionContextSource,
  type UsageStateSource,
} from "@/modules/P7/contract";
import type { OmpRuntimeStore, SessionInfoState } from "@/modules/R0/store";
import type { OverlayHostApi } from "@/overlay";
import { useOverlayHost } from "@/overlay";
import { reportClientError } from "./client-errors";
import { useModelPaletteCommand } from "./palette-model-command";

interface SessionControlProps {
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  /** The workspace folder the chat runs in: its project's roles are the ones the dialog shows. */
  readonly folder: FolderPath | null;
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

/** What opening the session's model dialog needs: the host to open it in, and the session it changes. */
export interface SessionModelDialogOptions {
  readonly overlay: OverlayHostApi;
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  /** Where focus goes back when the dialog closes; omitted, the focused opener is used. */
  readonly restoreFocus?: HTMLElement;
}

/**
 * Opens the model and thinking dialog for the session: the model hub (Recent, the providers, the Roles
 * view) and the thinking level. The header's model button, the palette's model command and a refused-key
 * notice all open it, so the lists are built the same way for each. Its models, recents, roles and
 * thinking state are made when the dialog opens and disposed when it closes.
 */
export function openSessionModelDialog({
  overlay,
  client,
  store,
  threadId,
  capabilities,
  folder,
  restoreFocus,
}: SessionModelDialogOptions): void {
  const catalog = new ModelCatalogModel({
    source: createRpcModelCatalogSource(client, threadId),
    capabilities,
    liveState: createR0LiveModelState({
      getSnapshot: () => ({ model: store.getSnapshot().session.model }),
      subscribe: (listener) => store.subscribe(() => listener()),
    }),
  });
  const recents = new RecentModels(createConfigRecentModelsPort(client));
  const thinking = new ThinkingLevelsController({
    source: createRpcThinkingSource(client, threadId),
    capabilities,
    live: liveThinking(store),
  });
  const rpc = client.port(RpcSessionPort) as RpcSessionClient;
  /**
   * The header reads R0's copy of omp's state, which is read again at a turn's end. After the person
   * changes the model or the thinking level, read it now so the header shows what omp uses.
   */
  const refreshSession = () => {
    // The answer describes omp as of this request: a run that starts after it is newer than the answer.
    const asOfSeq = store.getSnapshot().lastSeq;
    void rpc
      .send({ threadId, command: { type: "get_state" } })
      .then((state) => store.applySessionState(state, { asOfSeq }))
      .catch((error: unknown) => {
        reportClientError({
          kind: "error",
          message: `The session state could not be read after a change: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      });
  };
  const hub = new ModelHubController({
    catalog,
    recents,
    capabilities: () => capabilities,
    onSessionChanged: refreshSession,
    // The thinking controller loads the levels of the session's current model first, so the new model's levels are accepted.
    setSessionThinking: async (level) => {
      await thinking.refresh();
      await thinking.apply({ level, scope: "session" });
    },
  });
  const opened = overlay.open({
    kind: "modal",
    label: "Model and thinking",
    ...(restoreFocus === undefined ? {} : { restoreFocus }),
    // One size rule, no breakpoints: nearly the whole window when it is small, a roomy 48 by
    // 52rem box when it is large. The content sets no width of its own, so it can never be
    // wider than this frame (it used to ask for 36rem inside a 32rem frame and was cut off).
    className:
      "h-[min(calc(100dvh-1rem),52rem)] w-[min(calc(100vw-1rem),48rem)] max-h-none max-w-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
    content: ({ close }) => (
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
        <ModelHubPanel controller={hub} />
        <ThinkingSelector controller={thinking} onApplied={refreshSession} />
        <Button className="self-end" onClick={() => close()} type="button" variant="outline">
          Done
        </Button>
      </div>
    ),
  });
  void opened.closed.then(() => {
    hub.dispose();
    thinking.dispose();
  });
  void catalog.refresh().catch(() => undefined);
  void recents.read();
  void openHubRoles(client, folder).then(
    (roles) => hub.attachRoles(roles),
    (error: unknown) =>
      hub.failRoles(error instanceof Error ? error.message : "The roles could not be read."),
  );
}

/**
 * The header's model button: names the session's model and thinking level and opens the model dialog for
 * this session. The palette's model command opens the same dialog.
 */
export function SessionModelControl({
  client,
  store,
  threadId,
  capabilities,
  folder,
}: SessionControlProps) {
  const overlay = useOverlayHost();
  const session = useSessionInfo(store);
  const modelName = session.model?.name ?? session.model?.id;
  const parsedLevel = session.model?.reasoning
    ? ThinkingLevel.safeParse(session.thinkingLevel)
    : null;
  const level =
    parsedLevel?.success && parsedLevel.data !== "off"
      ? thinkingLevelLabel(parsedLevel.data).toLowerCase()
      : null;
  const openDialog = (restoreFocus?: HTMLElement) =>
    openSessionModelDialog({
      overlay,
      client,
      store,
      threadId,
      capabilities,
      folder,
      restoreFocus,
    });
  const open = () => openDialog();
  useModelPaletteCommand(openDialog);
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
}: Omit<SessionControlProps, "capabilities" | "folder">) {
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
      limits: createUsageLimitsSource(client),
    };
  }, [client, store, threadId]);
  return <ContextStatusBar context={ports.context} usage={ports.usage} limits={ports.limits} />;
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
