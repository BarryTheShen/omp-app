import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { Revision } from "./shared";

export const ExtensionSource = z.enum(["extension", "plugin", "skill"]);
export type ExtensionSource = z.infer<typeof ExtensionSource>;

/** Safe metadata only; `path` is relative to omp's root and never an absolute filesystem path. */
export const ExtensionSummary = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  source: ExtensionSource,
  version: z.string().min(1).optional(),
  marketplacePluginId: z.string().min(1).optional(),
  marketplaceScope: z.enum(["user", "project"]).optional(),
  enabled: z.boolean(),
  shadowed: z.boolean(),
  capabilities: z.array(z.string().min(1)),
  path: z.string().min(1),
  description: z.string().optional(),
  error: z.string().min(1).optional(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummary>;

/** A command declared by an extension/plugin; command file contents never leave the server. */
export const CommandMetadata = z.strictObject({
  name: z.string().min(1),
  provider: z.string().min(1),
  source: ExtensionSource,
  path: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),
});
export type CommandMetadata = z.infer<typeof CommandMetadata>;

export const ExtensionCatalogArgs = z.strictObject({
  /** `null` discovers user/global roots only; a folder adds its `.omp` roots. */
  folder: FolderPath.nullable(),
});
export type ExtensionCatalogArgs = z.infer<typeof ExtensionCatalogArgs>;

export const ExtensionCatalogResult = z.strictObject({
  revision: Revision,
  extensions: z.array(ExtensionSummary),
  commands: z.array(CommandMetadata),
});
export type ExtensionCatalogResult = z.infer<typeof ExtensionCatalogResult>;

export const ExtensionCatalogChanged = z.strictObject({
  revision: Revision,
  reason: z.enum(["filesystem", "reload", "omp"]),
});
export type ExtensionCatalogChanged = z.infer<typeof ExtensionCatalogChanged>;

export const ExtensionCatalog = definePort({
  name: "A1.extensionCatalog",
  methods: {
    list: {
      args: ExtensionCatalogArgs,
      result: ExtensionCatalogResult,
      capability: "host.extension-catalog",
    },
    reload: {
      args: ExtensionCatalogArgs,
      result: ExtensionCatalogResult,
      capability: "host.extension-catalog",
    },
  },
  events: {
    changed: {
      payload: ExtensionCatalogChanged,
      capability: "host.extension-catalog",
    },
  },
});
