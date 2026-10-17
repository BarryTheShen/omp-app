import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, FolderPath } from "@omp-app/contracts";
import {
  createConfigChangeSource,
  createConfigStoreClient,
  SettingsRuntime,
  type SettingsRuntimeSnapshot,
  useSettingsRuntime,
} from "../../S1/runtime";
import { PROVIDER_SETTINGS_SECTIONS } from "./descriptors";

export type ProviderSettingsControllerOptions = {
  readonly client: AppClient;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  readonly layer?: "global" | "project";
  readonly initialSectionId?: string;
};

export interface ProviderSettingsController {
  readonly capabilities: CapabilityMap;
  readonly descriptors: typeof PROVIDER_SETTINGS_SECTIONS;
  readonly selectedSectionId: () => string;
  readonly layer: () => "global" | "project";
  readonly canSaveToProject: () => boolean;
  readonly select: (sectionId: string) => void;
  readonly selectLayer: (layer: "global" | "project") => void;
  readonly runtime: (sectionId: string) => SettingsRuntime;
  readonly snapshots: () => readonly SettingsRuntimeSnapshot[];
  readonly dispose: () => void;
}

export function createProviderSettingsController(
  options: ProviderSettingsControllerOptions,
): ProviderSettingsController {
  const selected =
    options.initialSectionId &&
    PROVIDER_SETTINGS_SECTIONS.some(({ id }) => id === options.initialSectionId)
      ? options.initialSectionId
      : PROVIDER_SETTINGS_SECTIONS[0]?.id;
  if (!selected) throw new Error("Provider settings require at least one section.");
  const source = createConfigChangeSource(options.client, options.folder);
  const client = createConfigStoreClient(options.client);
  let layer = options.layer ?? (options.folder === null ? "global" : "project");
  if (layer === "project" && options.folder === null) layer = "global";
  let runtimes = makeRuntimes(layer);
  let runtimeById = indexRuntimes(runtimes);
  let selectedSectionId = selected;
  let disposed = false;

  function makeRuntimes(writeLayer: "global" | "project"): SettingsRuntime[] {
    return PROVIDER_SETTINGS_SECTIONS.map(
      (descriptor) =>
        new SettingsRuntime(client, source, {
          descriptor,
          folder: options.folder,
          layer: writeLayer,
        }),
    );
  }
  function indexRuntimes(values: readonly SettingsRuntime[]): Record<string, SettingsRuntime> {
    return Object.fromEntries(
      PROVIDER_SETTINGS_SECTIONS.map((descriptor, index) => [descriptor.id, values[index]]),
    ) as Record<string, SettingsRuntime>;
  }
  function disposeRuntimes(values: readonly SettingsRuntime[]): void {
    for (const runtime of values) runtime.dispose();
  }

  return {
    capabilities: options.capabilities,
    descriptors: PROVIDER_SETTINGS_SECTIONS,
    selectedSectionId: () => selectedSectionId,
    layer: () => layer,
    canSaveToProject: () => options.folder !== null,
    select(sectionId) {
      if (runtimeById[sectionId]) selectedSectionId = sectionId;
    },
    selectLayer(nextLayer) {
      if (disposed || nextLayer === layer) return;
      if (nextLayer === "project" && options.folder === null) return;
      disposeRuntimes(runtimes);
      layer = nextLayer;
      runtimes = makeRuntimes(layer);
      runtimeById = indexRuntimes(runtimes);
    },
    runtime(sectionId) {
      const runtime = runtimeById[sectionId];
      if (!runtime) throw new Error("Unknown provider settings section.");
      return runtime;
    },
    snapshots: () => runtimes.map((runtime) => runtime.getSnapshot()),
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeRuntimes(runtimes);
    },
  };
}

export { useSettingsRuntime };
