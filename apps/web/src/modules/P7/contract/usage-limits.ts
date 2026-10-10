import type { AppClient } from "@omp-app/client";
import { AppFailure, UsageLimitStore, type UsageLimitsResult } from "@omp-app/contracts";

/** Where the usage popover reads omp's provider limits from. A failed read comes back as unavailable, never thrown. */
export interface UsageLimitsSource {
  readonly read: () => Promise<UsageLimitsResult>;
}

/** Reads the host's provider limits (`A1.usageLimitStore`), with the failure's own words when the read fails. */
export function createUsageLimitsSource(client: AppClient): UsageLimitsSource {
  return {
    read: async () => {
      try {
        return await client.port(UsageLimitStore).read({});
      } catch (failure) {
        return {
          state: "unavailable" as const,
          reason:
            failure instanceof AppFailure
              ? failure.appError.message
              : "Provider limits could not be read.",
        };
      }
    },
  };
}
