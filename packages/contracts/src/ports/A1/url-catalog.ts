import { z } from "zod";
import { definePort } from "../../core/envelope";
import { Revision } from "./shared";

export const URL_CATALOG_LIMIT = 50;
export const URL_CATALOG_SCHEMES = [
  "skill",
  "rule",
  "omp",
  "local",
  "memory",
  "agent",
  "artifact",
] as const;
export const UrlScheme = z.enum(URL_CATALOG_SCHEMES);
export type UrlScheme = z.infer<typeof UrlScheme>;

export const UrlResourceKind = z.enum([
  "skill",
  "rule",
  "omp",
  "local",
  "memory",
  "agent",
  "artifact",
  "app",
]);
export type UrlResourceKind = z.infer<typeof UrlResourceKind>;

export const UrlResource = z.strictObject({
  scheme: UrlScheme,
  value: z.string().max(4096),
  uri: z.string().min(1).max(8192),
  label: z.string().min(1).max(512),
  description: z.string().max(2_000).optional(),
  kind: UrlResourceKind,
  source: z.enum(["omp", "app"]),
});
export type UrlResource = z.infer<typeof UrlResource>;

export const UrlCatalogListArgs = z.strictObject({
  query: z.string().max(512).default(""),
  scheme: UrlScheme.optional(),
  limit: z.int().min(1).max(URL_CATALOG_LIMIT).default(URL_CATALOG_LIMIT),
});
export type UrlCatalogListArgs = z.infer<typeof UrlCatalogListArgs>;

export const UrlCatalogResult = z.strictObject({
  revision: Revision,
  resources: z.array(UrlResource).max(URL_CATALOG_LIMIT),
});
export type UrlCatalogResult = z.infer<typeof UrlCatalogResult>;

export const UrlCatalogChanged = z.strictObject({ revision: Revision });
export type UrlCatalogChanged = z.infer<typeof UrlCatalogChanged>;

export const UrlCatalogPort = definePort({
  name: "A1.urlCatalog",
  methods: {
    list: {
      args: UrlCatalogListArgs,
      result: UrlCatalogResult,
      capability: "host.url-catalog",
    },
    refresh: {
      args: UrlCatalogListArgs,
      result: UrlCatalogResult,
      capability: "host.url-catalog",
    },
  },
  events: {
    changed: {
      payload: UrlCatalogChanged,
      capability: "host.url-catalog",
    },
  },
});
