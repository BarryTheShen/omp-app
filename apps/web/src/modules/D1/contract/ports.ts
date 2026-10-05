import type { Revision } from "@omp-app/contracts";
import type {
  ModelApplyRequest,
  ModelApplyResult,
  ModelCatalogResult,
  ModelCatalogSnapshot,
  ModelError,
  ModelScope,
  ModelSettings,
  ModelSettingsSnapshot,
  ThinkingApplyRequest,
  ThinkingCycleDirection,
  ThinkingLevelsResult,
  ThinkingLevelsSnapshot,
} from "./models";

export interface ModelCatalogPort {
  readonly getSnapshot: () => ModelCatalogSnapshot;
  readonly refresh: () => Promise<ModelCatalogResult>;
  readonly apply: (request: ModelApplyRequest) => Promise<ModelApplyResult>;
  readonly subscribe: (listener: (snapshot: ModelCatalogSnapshot) => void) => () => void;
}

export interface ThinkingLevelsPort {
  readonly getSnapshot: () => ThinkingLevelsSnapshot;
  readonly refresh: () => Promise<ThinkingLevelsResult>;
  readonly apply: (request: ThinkingApplyRequest) => Promise<ThinkingLevelsResult>;
  readonly cycle: (direction: ThinkingCycleDirection) => Promise<ThinkingLevelsResult>;
  readonly subscribe: (listener: (snapshot: ThinkingLevelsSnapshot) => void) => () => void;
}

/** The default/role layer is ConfigStore-owned; D1 consumes it through this typed adapter seam. */
export interface ModelSettingsPort {
  readonly getSnapshot: () => ModelSettingsSnapshot;
  readonly read: () => Promise<ModelSettingsSnapshot>;
  readonly write: (
    settings: ModelSettings,
    expectedRevision: Revision,
  ) => Promise<ModelSettingsSnapshot>;
  readonly subscribe: (listener: (snapshot: ModelSettingsSnapshot) => void) => () => void;
}

export interface ModelContractFailure {
  readonly error: ModelError;
  readonly scope?: ModelScope;
}
