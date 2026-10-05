import {
  type AbortSignalLike,
  AppFailure,
  URL_CATALOG_SCHEMES,
  type UrlCatalogListArgs,
  UrlCatalogListArgs as UrlCatalogListArgsSchema,
  type UrlCatalogResult,
  UrlResource,
  type UrlResource as UrlResourceValue,
  type UrlScheme,
} from "@omp-app/contracts";

const MAX_RESOURCES = 2_000;

export interface UrlCatalogResourceInput {
  readonly scheme: UrlScheme;
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: UrlResourceValue["kind"];
  readonly source: "omp" | "app";
  readonly permission?: "allowed" | "denied";
}

export interface UrlCatalogOptions {
  readonly resources?: readonly UrlCatalogResourceInput[];
  /** Reads omp/app metadata when the cache is first used or refreshed. */
  readonly loadResources?: (
    signal?: AbortSignalLike,
  ) => readonly UrlCatalogResourceInput[] | Promise<readonly UrlCatalogResourceInput[]>;
  /** Wire this to omp metadata changes; invalidation never fetches private resource content. */
  readonly subscribeInvalidation?: (invalidate: () => void) => () => void;
}

export type UrlCatalogChangeListener = (revision: string) => void;

export interface UrlCatalogService {
  list(args: UrlCatalogListArgs, signal?: AbortSignalLike): Promise<UrlCatalogResult>;
  refresh(args: UrlCatalogListArgs, signal?: AbortSignalLike): Promise<UrlCatalogResult>;
  invalidate(): void;
  subscribe(listener: UrlCatalogChangeListener): () => void;
  dispose(): void;
}

type CachedCatalog = {
  readonly revision: string;
  readonly resources: readonly UrlResourceValue[];
};

/**
 * Builds a bounded metadata-only catalog. It exposes the seven schemes used by omp's
 * `internal-url-autocomplete.ts` and accepts app-registered resources without reading them.
 */
export function createUrlCatalog(options: UrlCatalogOptions = {}): UrlCatalogService {
  let revisionNumber = 0;
  let cache: CachedCatalog | undefined;
  let loading: Promise<CachedCatalog> | undefined;
  const listeners = new Set<UrlCatalogChangeListener>();
  const unsubscribeSource = options.subscribeInvalidation?.(() => invalidate());

  return {
    async list(args, signal) {
      const parsed = UrlCatalogListArgsSchema.safeParse(args);
      if (!parsed.success) throw invalidArgsFailure();
      const catalog = await getCatalog(signal);
      return filterCatalog(catalog, parsed.data);
    },

    async refresh(args, signal) {
      const parsed = UrlCatalogListArgsSchema.safeParse(args);
      if (!parsed.success) throw invalidArgsFailure();
      invalidate();
      const catalog = await getCatalog(signal);
      return filterCatalog(catalog, parsed.data);
    },

    invalidate,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      unsubscribeSource?.();
      listeners.clear();
      cache = undefined;
    },
  };

  function invalidate(): void {
    revisionNumber += 1;
    cache = undefined;
    const revision = revisionValue(revisionNumber);
    for (const listener of listeners) listener(revision);
  }

  async function getCatalog(signal?: AbortSignalLike): Promise<CachedCatalog> {
    assertNotAborted(signal);
    if (cache !== undefined) return cache;
    if (loading !== undefined) return loading;
    loading = loadCatalog(signal).finally(() => {
      loading = undefined;
    });
    return loading;
  }

  async function loadCatalog(signal?: AbortSignalLike): Promise<CachedCatalog> {
    const external = options.loadResources ? await options.loadResources(signal) : [];
    assertNotAborted(signal);
    const resources = normalizeResources([
      ...defaultResources(),
      ...(options.resources ?? []),
      ...external,
    ]);
    const value = { revision: revisionValue(revisionNumber), resources };
    cache = value;
    return value;
  }
}

function defaultResources(): readonly UrlCatalogResourceInput[] {
  return URL_CATALOG_SCHEMES.map((scheme) => ({
    scheme,
    value: "",
    label: `${scheme} resources`,
    description: `Registered ${scheme}:// internal resources`,
    kind: scheme,
    source: "omp" as const,
    permission: "allowed" as const,
  }));
}

function normalizeResources(
  inputs: readonly UrlCatalogResourceInput[],
): readonly UrlResourceValue[] {
  const resources: UrlResourceValue[] = [];
  const keys = new Set<string>();
  for (const input of inputs.slice(0, MAX_RESOURCES)) {
    if (input.permission === "denied") continue;
    const key = `${input.scheme}:${input.value}`;
    if (keys.has(key)) continue;
    const parsed = UrlResource.safeParse({
      scheme: input.scheme,
      value: input.value,
      uri: `${input.scheme}://${input.value}`,
      label: input.label,
      ...(input.description === undefined ? {} : { description: input.description }),
      kind: input.kind,
      source: input.source,
    });
    if (!parsed.success) continue;
    keys.add(key);
    resources.push(parsed.data);
  }
  return resources;
}

function filterCatalog(catalog: CachedCatalog, args: UrlCatalogListArgs): UrlCatalogResult {
  const query = args.query.toLocaleLowerCase();
  const candidates = catalog.resources
    .filter((resource) => args.scheme === undefined || resource.scheme === args.scheme)
    .map((resource) => ({ resource, score: scoreResource(resource, query) }))
    .filter(
      (entry): entry is { readonly resource: UrlResourceValue; readonly score: number } =>
        entry.score !== null,
    )
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.resource.uri < right.resource.uri
        ? -1
        : left.resource.uri > right.resource.uri
          ? 1
          : 0;
    });
  return {
    revision: catalog.revision,
    resources: candidates.slice(0, args.limit).map((entry) => entry.resource),
  };
}

function scoreResource(resource: UrlResourceValue, query: string): number | null {
  if (query.length === 0) return 0;
  const target =
    `${resource.value} ${resource.label} ${resource.description ?? ""}`.toLocaleLowerCase();
  let cursor = 0;
  let score = 0;
  for (const character of query) {
    const index = target.indexOf(character, cursor);
    if (index < 0) return null;
    score += index === cursor ? 3 : 1;
    cursor = index + 1;
  }
  return score * 100 - target.length;
}

function revisionValue(number: number): string {
  return `url-${number}`;
}

function assertNotAborted(signal: AbortSignalLike | undefined): void {
  if (!signal?.aborted) return;
  throw new AppFailure({
    code: "cancelled",
    message: "The URL catalog request was cancelled.",
    retryable: false,
  });
}

function invalidArgsFailure(): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message: "The URL catalog arguments are invalid.",
    retryable: false,
  });
}
