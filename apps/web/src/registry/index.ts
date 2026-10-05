/**
 * The app's composition index: every module's descriptors and renderers, merged into one
 * registry. U0.5 ships it empty; from here on only the main agent edits it, adding one import and
 * one spread per module as that module's descriptors and renderers merge
 * (`AGENTS.md`, "Who may change what"; `apps/web/src/registry/` ownership in
 * `packages/contracts/README.md`).
 */
import type { Descriptor } from "@omp-app/contracts";
import { N1_DESCRIPTORS } from "../modules/N1/descriptors";
import { P4_DESCRIPTORS } from "../modules/P4/contract";
import { R1_DESCRIPTORS } from "../modules/R1/descriptors";
import { U1MessageDescriptors } from "../modules/U1/registry/messages";
import { U2Descriptors } from "../modules/U2/descriptors";
import { createRegistry, type RendererMap } from "../registry-core";

export const DESCRIPTORS: readonly Descriptor[] = [
  ...U1MessageDescriptors,
  ...U2Descriptors,
  ...R1_DESCRIPTORS,
  ...N1_DESCRIPTORS,
  ...P4_DESCRIPTORS,
];

export const RENDERERS: RendererMap = {};

/** Built once at module load, so a registry conflict fails immediately rather than on first render. */
export const registry = createRegistry(DESCRIPTORS);
