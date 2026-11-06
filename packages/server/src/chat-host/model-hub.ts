/**
 * The chat host's model hub methods (`get_model_hub`, `assign_model_role`, `clear_model_role`): what omp's model hub
 * (Alt+M) shows and does with roles, taken from omp 18.12.6 rule for rule. The rows are the hub's own
 * (`pi-tui/src/overlays/model-hub.ts`, `model-browser.ts`) and the two writes are the hub's callbacks
 * (`modes/controllers/selector-controller.ts:947-1116`), minus the terminal's status line and editor border. Where omp
 * shows a status line the methods return it; where omp shows an error they throw it.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
  acquireModelRoleMutation,
  applyModelPreset as applyOmpModelPreset,
  deleteModelPreset as deleteOmpModelPreset,
  findActiveModelPreset,
  formatModelPresetSwitch,
  getModelPresetNames,
  isCleanModelPresetSwitch,
  isValidModelPresetName,
  modelPresetSavedMessage,
  saveModelPreset as saveOmpModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgModelRoleStorage } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  cfgDefaultThinkingLevel,
  cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import {
  buildBrowserItems,
  resolveRoleAssignments,
  scopedRolePool,
  sortModelItems,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
  AUTO_THINKING,
  type ConfiguredThinkingLevel,
  concreteThinkingLevel,
  parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import type {
  AssignModelRoleParams,
  ClearModelRoleParams,
  HubModel,
  HubRole,
  ModelHub,
  ModelPresetParams,
  SetRoleFallbacksParams,
} from "@omp-app/contracts/chat-host";

/**
 * The available model with this provider and id. One that is not in the catalog yet waits for omp's background
 * discovery first (a discovery-backed provider fills in seconds after start), as omp's own lookup does
 * (`rpc-mode.ts:959-965`).
 */
export async function findModel(session: AgentSession, provider: string, modelId: string) {
  const find = () =>
    session
      .getAvailableModels()
      .find((model) => model.provider === provider && model.id === modelId);
  const model = find();
  if (model) return model;
  await session.modelRegistry.awaitBackgroundRefresh();
  return find();
}

/**
 * The thinking levels a role assignment can apply to a model (`ModelHubComponent#thinkingOptionsFor`, `model-hub.ts`
 * 1329-1333). A model that does not reason gets none: no request sends reasoning for it, so `inherit`, `off` and `auto`
 * would all be no-ops. A reasoner without an effort dial keeps the always-on levels, and `auto` only where its
 * reasoning surface is verified.
 */
function thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
  if (!model.reasoning) return [];
  if (model.thinking?.unverified)
    return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
  return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
}

/**
 * What omp's hub shows for the chat: its roles with the model each resolves to, and the models a role can take. The
 * model pool is the hub's (`model-hub.ts:597-622`): the `--models` scope when the chat has one, else the registry's
 * catalog as it is now.
 */
export function readModelHub(session: AgentSession): ModelHub {
  const settings = session.settings;
  const source = createModelBrowserSource(settings, (model) => session.effectiveServiceTier(model));
  const registry = session.modelRegistry;
  const scoped = session.scopedModels;

  let allModels: ReadonlyArray<Model>;
  let availableModels: ReadonlyArray<Model>;
  if (scoped.length > 0) {
    const scopedModels = scoped.map((entry) => entry.model);
    try {
      allModels = scopedRolePool(scopedModels, registry);
    } catch {
      allModels = scopedModels;
    }
    availableModels = allModels;
  } else {
    allModels = registry.getAll("all");
    try {
      availableModels = registry.getAvailable("all");
    } catch {
      availableModels = [];
    }
  }
  const assignments = resolveRoleAssignments(source, allModels, availableModels);

  const infos = new Map(
    source.knownRoleIds
      .map((role) => [role, source.getRoleInfo(role)] as const)
      .filter(([, info]) => !info.hidden),
  );
  const roles: HubRole[] = [...infos].map(([role, info]) => {
    const assigned = assignments[role];
    return {
      role,
      tag: info.tag ?? null,
      name: info.name,
      section: info.section,
      value: settings.getModelRole(role) ?? null,
      provenance: settings.getModelRoleProvenance(role),
      model: assigned
        ? {
            provider: assigned.model.provider,
            modelId: assigned.model.id,
            name: assigned.model.name,
          }
        : null,
      thinkingLevel: assigned ? `${assigned.thinkingLevel}` : null,
      autoSelected: assigned?.autoSelected ?? false,
      fallbacks: [...(source.fallbackChains[role] ?? [])],
    };
  });
  // The hub's own order: models with a role first, then the most recently used, then by provider and recency.
  const items = buildBrowserItems(availableModels);
  sortModelItems(items, { roles: assignments, mruOrder: source.mruOrder });
  const models: HubModel[] = items.map(({ model }) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? null,
    reasoning: Boolean(model.reasoning),
    thinkingLevels: thinkingOptionsFor(model).map((level) => `${level}`),
    roles: [...infos].filter(([, info]) => info.accepts(model)).map(([role]) => role),
  }));
  const live = session.model;
  return {
    storage: cfgModelRoleStorage.get(settings),
    current: live ? { provider: live.provider, modelId: live.id } : null,
    roles,
    models,
    presets: {
      names: getModelPresetNames(settings),
      active: findActiveModelPreset(settings) ?? null,
    },
  };
}

/**
 * The hub's `onAssign` (`selector-controller.ts:947-1032`). `default` switches the live chat; any other role writes its
 * setting only. The model is looked up as `set_model` does, and its selector is `provider/id`, as the hub's rows have it.
 */
export async function assignModelRole(
  session: AgentSession,
  params: AssignModelRoleParams,
): Promise<{ readonly applied: boolean; readonly status: string }> {
  const model = await findModel(session, params.provider, params.modelId);
  if (!model) throw new Error(`Model not found: ${params.provider}/${params.modelId}`);
  const settings = session.settings;
  const { role } = params;
  const thinkingLevel =
    params.thinkingLevel === undefined
      ? undefined
      : parseConfiguredThinkingLevel(params.thinkingLevel);
  const selector = `${model.provider}/${model.id}`;

  const releaseDefaultMutation = role === "default" ? await acquireModelRoleMutation() : undefined;
  const configuredStorage = cfgModelRoleStorage.get(settings);
  const targetScope = configuredStorage === "project" ? (params.scope ?? "project") : "global";
  const selectorValue = selector;
  const scopeLabel =
    configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
  const defaultStatusLabel = configuredStorage === "project" ? `${scopeLabel}default` : "Default";
  try {
    if (role === "default") {
      // `auto` on the default role configures the active session. Other roles persist an explicit `:auto` suffix and
      // must not mutate the current model.
      const isAuto = thinkingLevel === AUTO_THINKING;
      const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
      const effectiveProvenance = settings.getModelRoleProvenance("default");
      const shadowedGlobal =
        configuredStorage === "project" &&
        targetScope === "global" &&
        (effectiveProvenance === "project" ||
          effectiveProvenance === "overlay" ||
          (effectiveProvenance === "runtime" &&
            settings.isProjectModelRoleRuntimeOverrideActive("default")));
      const shadowedProject =
        configuredStorage === "project" &&
        targetScope === "project" &&
        effectiveProvenance === "overlay";
      if (shadowedGlobal) {
        settings.setModelRole("default", formatModelSelectorValue(selectorValue, concreteThinking));
        if (isAuto) cfgDefaultThinkingLevel.set(settings, AUTO_THINKING);
      } else if (shadowedProject) {
        settings.setProjectModelRole(
          "default",
          formatModelSelectorValue(selectorValue, concreteThinking),
        );
        if (isAuto) cfgDefaultThinkingLevel.set(settings, AUTO_THINKING);
      } else {
        const { switched } = await session.setModel(model, role, {
          selector,
          thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
          persist: targetScope === "global",
        });
        if (!switched) return { applied: false, status: "" };
        if (targetScope === "project") {
          settings.setProjectModelRole(
            "default",
            formatModelSelectorValue(selectorValue, concreteThinking),
          );
        }
        if (isAuto) {
          session.setThinkingLevel(AUTO_THINKING, true);
        } else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
          session.setThinkingLevel(concreteThinking);
        }
      }
      return { applied: true, status: `${defaultStatusLabel} model: ${selector}` };
    }
    // Other roles (smol, slow, custom): update settings, not the current model.
    const modelRoleValue = formatModelSelectorValue(selectorValue, thinkingLevel);
    if (targetScope === "project") {
      settings.setProjectModelRole(role, modelRoleValue);
    } else {
      settings.setModelRole(role, modelRoleValue);
    }
    const roleInfo = getRoleInfo(role, settings);
    return {
      applied: true,
      status: `${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} model: ${selector}`,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    releaseDefaultMutation?.();
  }
}

/**
 * The hub's `onFallbackChainChange` (`selector-controller.ts:1117-1129`, #2838): writes the role's chain to omp's
 * `retry.fallbackChains`, or clears it when empty, and says so in omp's words.
 */
export function setRoleFallbacks(
  session: AgentSession,
  params: SetRoleFallbacksParams,
): { readonly status: string } {
  const settings = session.settings;
  cfgRetryFallbackChains.setEntry(
    settings,
    params.role,
    params.chain.length > 0 ? params.chain : undefined,
  );
  const info = getRoleInfo(params.role, settings);
  const label = info?.tag ?? info?.name ?? params.role;
  return {
    status:
      params.chain.length > 0
        ? `${label} fallbacks: ${params.chain.join(" → ")}`
        : `${label} fallbacks cleared`,
  };
}

/**
 * The hub's `onSavePreset` (`selector-controller.ts:1180-1187`, #2838): the current role assignments and default thinking
 * level as `name`, in omp's words. A name omp does not take is refused with its message, as `/modelpreset save` says it.
 */
export function saveModelPreset(
  session: AgentSession,
  params: ModelPresetParams,
): { readonly status: string } {
  if (!isValidModelPresetName(params.name)) {
    throw new Error(
      `Invalid preset name "${params.name}": use a letter, then letters, digits, - or _`,
    );
  }
  saveOmpModelPreset(session.settings, params.name);
  return { status: modelPresetSavedMessage(session.settings, params.name) };
}

/**
 * The hub's `onSwitchPreset` (`selector-controller.ts:1188-1203`, #2838): writes the preset's roles and moves this chat to
 * its default model, in omp's words; `clean` is false where omp warns instead (not found, unavailable, roles decided
 * elsewhere).
 */
export async function applyModelPreset(
  session: AgentSession,
  params: ModelPresetParams,
): Promise<{ readonly status: string; readonly clean: boolean }> {
  const result = await applyOmpModelPreset(session.settings, session, params.name);
  return {
    status: formatModelPresetSwitch(params.name, result),
    clean: isCleanModelPresetSwitch(result),
  };
}

/** `/modelpreset delete` (`builtin-modes.ts:984-995`, #2838): removes the preset from the global settings, in omp's words. */
export function deleteModelPreset(
  session: AgentSession,
  params: ModelPresetParams,
): { readonly status: string; readonly deleted: boolean } {
  const result = deleteOmpModelPreset(session.settings, params.name);
  if (result === "deleted")
    return { status: `Deleted model preset "${params.name}"`, deleted: true };
  if (result === "project")
    return {
      status: `Preset "${params.name}" is defined by a project or --config file; remove it there`,
      deleted: false,
    };
  return { status: `Preset not found: ${params.name}`, deleted: false };
}

/**
 * The hub's `onUnassign` (`selector-controller.ts:1033-1116`): clears the role's setting in the chosen layer. Clearing
 * `default` can expose another persisted default; when that changes the effective default, or the live chat runs another
 * model, the chat switches to it without writing it back (`switchedTo`, which omp reports as "Default model: …").
 */
export async function clearModelRole(
  session: AgentSession,
  params: ClearModelRoleParams,
): Promise<{ readonly status: string; readonly switchedTo: string | null }> {
  const settings = session.settings;
  const { role } = params;
  const releaseDefaultMutation = role === "default" ? await acquireModelRoleMutation() : undefined;
  const configuredStorage = cfgModelRoleStorage.get(settings);
  const targetScope = configuredStorage === "project" ? (params.scope ?? "project") : "global";
  const scopeLabel =
    configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
  try {
    const previousEffectiveRoleValue =
      role === "default" ? settings.getModelRole("default") : undefined;
    if (targetScope === "project") {
      settings.clearProjectModelRole(role);
    } else {
      settings.setModelRole(role, undefined);
    }
    const roleInfo = getRoleInfo(role, settings);
    const status = `${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} role cleared — auto-selection applies`;
    // Clearing either persisted scope can also remove a captured runtime override. When that changes the effective
    // default, or the live session runs a different model than it (an earlier in-session pick that a project role
    // shadows), resolve the exposed persisted layer and switch the live session without writing it back to global
    // settings. Overlay and runtime provenance remain authoritative and session-neutral.
    if (role !== "default") return { status, switchedTo: null };
    const fallbackRoleValue = settings.getModelRole("default");
    const fallbackProvenance = settings.getModelRoleProvenance("default");
    const exposesPersistedFallback =
      fallbackProvenance === "project" || fallbackProvenance === "global";
    if (!fallbackRoleValue || !exposesPersistedFallback) return { status, switchedTo: null };
    const scopedModels = session.scopedModels.map((entry) => entry.model);
    const availableModels = scopedModels.length > 0 ? scopedModels : session.getAvailableModels();
    const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, { settings });
    const live = session.model;
    const liveDiffers =
      !live ||
      !resolved.model ||
      live.provider !== resolved.model.provider ||
      live.id !== resolved.model.id;
    if (!resolved.model || (fallbackRoleValue === previousEffectiveRoleValue && !liveDiffers)) {
      return { status, switchedTo: null };
    }
    const fallbackModel = resolved.model;
    const isAuto = resolved.thinkingLevel === AUTO_THINKING;
    let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
    let isAutoFromDefault = false;
    if (!resolved.explicitThinkingLevel && !concreteThinking) {
      const defaultLevel = parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings));
      if (defaultLevel === AUTO_THINKING) {
        isAutoFromDefault = true;
      } else if (defaultLevel) {
        concreteThinking = defaultLevel;
      }
    }
    const effectiveIsAuto = isAuto || isAutoFromDefault;
    const { switched } = await session.setModel(fallbackModel, "default", {
      persist: false,
      thinkingLevel: effectiveIsAuto
        ? ThinkingLevel.Inherit
        : (concreteThinking ?? ThinkingLevel.Inherit),
    });
    if (!switched) return { status, switchedTo: null };
    if (effectiveIsAuto) {
      session.setThinkingLevel(AUTO_THINKING, true);
    } else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
      session.setThinkingLevel(concreteThinking);
    }
    return { status, switchedTo: `${fallbackModel.provider}/${fallbackModel.id}` };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    releaseDefaultMutation?.();
  }
}
