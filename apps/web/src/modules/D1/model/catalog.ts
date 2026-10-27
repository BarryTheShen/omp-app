import type { AppClient } from "@omp-app/client";
import type {
  CapabilityKey,
  CapabilityMap,
  ChatSessionClient,
  OmpWire,
  PortCallOptions,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, ChatSessionPort } from "@omp-app/contracts";
import { readProviderSignIns } from "@/modules/D3/auth/sign-in";
import type { ProviderSignIn } from "@/modules/D3/contract";
import {
  D1_CAPABILITIES,
  type EffortLevel,
  EffortLevel as EffortLevelSchema,
  type ModelApplyRequest,
  type ModelApplyResult,
  type ModelCapabilities,
  ModelCapabilities as ModelCapabilitiesSchema,
  type ModelCatalogPort,
  type ModelCatalogResult,
  type ModelCatalogSnapshot,
  type ModelDescriptor,
  type ModelRef,
  modelScopeAvailability,
} from "../contract";

const INITIAL_REVISION = "catalog-initial";

export interface ModelCatalogMappingOptions {
  readonly lockedProviders?: ReadonlySet<string>;
  readonly unavailableProviders?: ReadonlySet<string>;
  /** How each provider is signed in, keyed by provider id; a provider not listed gets no label. */
  readonly signIns?: ReadonlyMap<string, ProviderSignIn>;
}

export interface ModelCatalogSource {
  /** How each provider is signed in; never rejects (a failed read gives no labels). */
  readonly readSignIns?: () => Promise<ReadonlyMap<string, ProviderSignIn>>;
  readonly getAvailableModels: (
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<readonly OmpWire.ModelInfo[]>;
  readonly setModel: (
    model: ModelRef,
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<OmpWire.ModelInfo>;
}

/** R0.1's live snapshot seam; D1 subscribes to it rather than polling get_state itself. */
export interface LiveModelState {
  readonly getSnapshot: () => { readonly model: ModelRef | null };
  readonly subscribe: (
    listener: (snapshot: { readonly model: ModelRef | null }) => void,
  ) => () => void;
}
export interface R0ModelStateSnapshot {
  readonly model: ModelRef | OmpWire.ModelInfo | null | undefined;
}

export interface R0ModelStateStore {
  readonly getSnapshot: () => R0ModelStateSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

function modelRefFromLiveValue(value: R0ModelStateSnapshot["model"]): ModelRef | null {
  if (!value) return null;
  return "modelId" in value
    ? { provider: value.provider, modelId: value.modelId }
    : { provider: value.provider, modelId: value.id };
}

/** Adapts R0.1's external store without issuing a second get_state request. */
export function createR0LiveModelState(store: R0ModelStateStore): LiveModelState {
  return {
    getSnapshot: () => ({ model: modelRefFromLiveValue(store.getSnapshot().model) }),
    subscribe: (listener) =>
      store.subscribe(() => listener({ model: modelRefFromLiveValue(store.getSnapshot().model) })),
  };
}

export interface ModelCatalogModelOptions {
  readonly source: ModelCatalogSource;
  readonly capabilities?: CapabilityMap;
  readonly liveState?: LiveModelState;
  readonly mapping?: ModelCatalogMappingOptions;
}

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function unavailable(capability: string, message: string): AppFailure {
  const key = capability as CapabilityKey;
  return new AppFailure({
    code: "unavailable",
    capability: key,
    message,
    retryable: false,
  });
}

export function modelKey(model: Pick<ModelRef, "provider" | "modelId">): string {
  return `${model.provider}/${model.modelId}`;
}

export function descriptorKey(model: Pick<ModelDescriptor, "provider" | "id">): string {
  return modelKey({ provider: model.provider, modelId: model.id });
}

export function modelRefFromDescriptor(model: Pick<ModelDescriptor, "provider" | "id">): ModelRef {
  return { provider: model.provider, modelId: model.id };
}

function safeEfforts(model: OmpWire.ModelInfo): EffortLevel[] {
  return (model.thinking?.efforts ?? []).filter(
    (effort): effort is EffortLevel => EffortLevelSchema.safeParse(effort).success,
  );
}

export function toModelDescriptor(
  model: OmpWire.ModelInfo,
  options: ModelCatalogMappingOptions = {},
): ModelDescriptor {
  const availability = options.unavailableProviders?.has(model.provider)
    ? "unavailable"
    : options.lockedProviders?.has(model.provider)
      ? "locked"
      : "available";
  const signIn = options.signIns?.get(model.provider);
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingEfforts: safeEfforts(model),
    availability,
    ...(availability === "locked" ? { loginProvider: model.provider } : {}),
    ...(signIn === undefined ? {} : { signIn }),
    description: model.reasoning ? "Reasoning model" : "General-purpose model",
  };
}

export function filterModels(
  models: readonly ModelDescriptor[],
  query: string,
): readonly ModelDescriptor[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return models;
  return models.filter((model) =>
    [model.provider, model.id, model.name, model.api, model.description ?? ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function roleSelectorKey(selector: string | ModelRef): string {
  return typeof selector === "string" ? selector : modelKey(selector);
}

function initialCapabilities(capabilities: CapabilityMap | undefined): ModelCapabilities {
  const entries = D1_CAPABILITIES.flatMap((key) => {
    const status = capabilities?.[key];
    return status ? [[key, status] as const] : [];
  });
  return ModelCapabilitiesSchema.parse(Object.fromEntries(entries));
}

function currentFrom(raw: OmpWire.ModelInfo | null | undefined): ModelRef | null {
  return raw ? { provider: raw.provider, modelId: raw.id } : null;
}

/**
 * Stateful catalog of the models omp can use, for the model dialog. It owns only browser presentation
 * state; RPC, R0 and A1 remain injected authorities.
 */
export class ModelCatalogModel implements ModelCatalogPort {
  private readonly source: ModelCatalogSource;
  private readonly capabilities: ModelCapabilities;
  private readonly mapping: ModelCatalogMappingOptions;
  private readonly listeners = new Set<(snapshot: ModelCatalogSnapshot) => void>();
  private snapshot: ModelCatalogSnapshot;
  private operation = 0;
  private liveUnsubscribe: (() => void) | undefined;

  public constructor(options: ModelCatalogModelOptions) {
    this.source = options.source;
    this.capabilities = initialCapabilities(options.capabilities);
    this.mapping = options.mapping ?? {};
    this.snapshot = Object.freeze({
      loadState: "idle",
      models: [],
      current: options.liveState?.getSnapshot().model ?? null,
      capabilities: this.capabilities,
      error: null,
    });
    if (options.liveState) {
      this.liveUnsubscribe = options.liveState.subscribe((next) => {
        this.commit({ current: next.model, error: null });
      });
    }
  }

  public getSnapshot(): ModelCatalogSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: ModelCatalogSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async refresh(options?: Pick<PortCallOptions, "signal">): Promise<ModelCatalogResult> {
    const operation = ++this.operation;
    this.commit({ loadState: "loading", error: null });
    try {
      const [rawModels, signIns] = await Promise.all([
        this.source.getAvailableModels(options),
        this.source.readSignIns?.() ?? Promise.resolve(new Map<string, ProviderSignIn>()),
      ]);
      if (operation !== this.operation) {
        return {
          models: [...this.snapshot.models],
          current: this.snapshot.current,
          capabilities: this.snapshot.capabilities,
          revision: INITIAL_REVISION,
        };
      }
      const models = rawModels.map((model) =>
        toModelDescriptor(model, { ...this.mapping, signIns }),
      );
      this.commit({ loadState: "ready", models, error: null });
      return {
        models,
        current: this.snapshot.current,
        capabilities: this.snapshot.capabilities,
        revision: INITIAL_REVISION,
      };
    } catch (error) {
      const appFailure = failure(error, "Loading available models failed.");
      if (operation === this.operation)
        this.commit({ loadState: "error", error: appFailure.appError });
      throw appFailure;
    }
  }

  public async apply(
    request: ModelApplyRequest,
    options?: Pick<PortCallOptions, "signal">,
  ): Promise<ModelApplyResult> {
    const availability = modelScopeAvailability(request.scope, this.snapshot.capabilities);
    if (availability.state === "unavailable") {
      throw unavailable(availability.capability, availability.reason);
    }
    if (request.scope !== "session") {
      throw new AppFailure({
        code: "invalid_args",
        message:
          "Choose a role to save a model as the default; direct model changes are session-only.",
        retryable: false,
      });
    }
    try {
      const selected = await this.source.setModel(request.model, options);
      const current = currentFrom(selected);
      this.commit({ current, error: null });
      return {
        model: current ?? request.model,
        scope: request.scope,
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        revision: INITIAL_REVISION,
      };
    } catch (error) {
      const appFailure = failure(error, "Changing the session model failed.");
      this.commit({ error: appFailure.appError });
      throw appFailure;
    }
  }

  public dispose(): void {
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = undefined;
    this.listeners.clear();
  }

  private commit(patch: Partial<ModelCatalogSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** Real browser implementation over the chat session port (SDK plan H5.4f). */
export function createRpcModelCatalogSource(
  client: AppClient,
  threadId: ThreadId,
): ModelCatalogSource {
  const session = client.port(ChatSessionPort) as ChatSessionClient;
  return {
    readSignIns: async () => readProviderSignIns({ client, threadId }),
    getAvailableModels: async (options) => {
      const result = await session.request(
        { threadId, method: "get_available_models", params: {} },
        options,
      );
      return result.models as unknown as readonly OmpWire.ModelInfo[];
    },
    setModel: async (model, options) =>
      (await session.request(
        {
          threadId,
          method: "set_model",
          params: { provider: model.provider, modelId: model.modelId },
        },
        options,
      )) as unknown as OmpWire.ModelInfo,
  };
}
