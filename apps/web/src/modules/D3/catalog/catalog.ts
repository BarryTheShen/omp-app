import type { AppClient } from "@omp-app/client";
import { type CapabilityMap, ProviderAccountStore, type ThreadId } from "@omp-app/contracts";
import type { ProfilePort, ProviderCatalog, ProviderCatalogPort } from "../contract";

export type ProviderCatalogOptions = {
  readonly client: AppClient;
  readonly capabilities: CapabilityMap;
  readonly threadId?: ThreadId;
};

/** Read-only redacted provider data for D1; credentials never cross A1's typed port. */
export function createProviderCatalog(options: ProviderCatalogOptions): ProviderCatalogPort {
  const store = options.client.port(ProviderAccountStore);
  return {
    capabilities: () => options.capabilities,
    async listProviders({ signal } = {}): Promise<ProviderCatalog> {
      const result = await store.listProviders({}, { signal });
      return { providers: result.providers };
    },
    async listAccounts(providerId, { signal } = {}) {
      const result = await store.listAccounts(
        { providerId, ...(options.threadId === undefined ? {} : { sessionId: options.threadId }) },
        { signal },
      );
      return result.accounts;
    },
  };
}

export type ProviderProfileOptions = ProviderCatalogOptions & {
  readonly providerId: string;
  readonly accountId?: string;
};

export function createProviderProfile(options: ProviderProfileOptions): ProfilePort {
  const catalog = createProviderCatalog(options);
  return {
    async getCurrent({ signal } = {}) {
      const accounts = await catalog.listAccounts(options.providerId, { signal });
      const account =
        (options.accountId === undefined
          ? accounts.find((candidate) => candidate.active)
          : accounts.find((candidate) => candidate.id === options.accountId)) ?? null;
      return account === null
        ? null
        : {
            providerId: account.providerId,
            accountId: account.id,
            label: account.label,
            active: account.active,
            source: account.source,
            ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
          };
    },
    /**
     * A1.11 declares no change events, so this profile is read-only and never emits notifications.
     * D1 can re-read through getCurrent when it needs a fresh profile.
     */
    subscribe() {
      return () => undefined;
    },
  };
}
