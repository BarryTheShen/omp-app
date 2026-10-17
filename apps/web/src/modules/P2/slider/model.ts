import type { EffortLevel, ModelCatalogPort, ModelRef } from "@/modules/D1/contract";
import { modelKey } from "@/modules/D1/model/catalog";
import { thinkingLevelLabel } from "@/modules/D1/thinking/selector";

export interface ExecutionTierOption {
  readonly value: EffortLevel;
  readonly label: string;
}

export interface ExecutionTierModel {
  readonly model: ModelRef;
  readonly options: readonly ExecutionTierOption[];
}

export function executionTierModel(catalog: ModelCatalogPort): ExecutionTierModel | null {
  const snapshot = catalog.getSnapshot();
  const current = snapshot.current;
  if (current === null || snapshot.loadState !== "ready") return null;
  const descriptor = snapshot.models.find(
    (model) => modelKey({ provider: model.provider, modelId: model.id }) === modelKey(current),
  );
  if (descriptor === undefined || descriptor.thinkingEfforts.length < 2) return null;
  return {
    model: current,
    options: descriptor.thinkingEfforts.map((value) => ({
      value,
      label: thinkingLevelLabel(value),
    })),
  };
}
