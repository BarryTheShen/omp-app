import { AppError, ConfigEntry, ConfigWriteArgs, ConfigWriteResult } from "@omp-app/contracts";

/**
 * The eight pins of omp's advisor section: the seven of research/omp-storage-and-config.md ("The exact advisor pins") and
 * `advisor.continueSeverity`, added by omp 18.12.1 (`advisor/settings.ts:65-84` at v18.12.6).
 * `model/Advisor` groups them; P1 reads and writes them through A1's ConfigStore.
 */
export const ADVISOR_SECTION_KEYS: readonly string[] = [
  "advisor.enabled",
  "advisor.syncBacklog",
  "advisor.immuneTurns",
  "advisor.continueSeverity",
  "advisor.reviewMode",
  "advisor.reviewInterval",
  "advisor.maxNotesPerUpdate",
  "advisor.evictStaleResults",
];

/** The advisor switch as the store lists it: a non-secret value and the layer that sets it. */
export const ADVISOR_ENABLED_ENTRY = ConfigEntry.parse({
  key: "advisor.enabled",
  secret: false,
  value: true,
  source: "global",
  overrides: [],
});

/**
 * A write that names the revision it read. The store applies it only if that revision is still current
 * (compare-and-set), so a value changed elsewhere is never overwritten silently.
 */
export const ADVISOR_ENABLED_WRITE = ConfigWriteArgs.parse({
  key: "advisor.enabled",
  layer: "global",
  value: { secret: false, value: false },
  folder: null,
  expectedRevision: "rev-7",
});

/** The store's answer when the expected revision was still current: the revision moves on. */
export const ADVISOR_ENABLED_WRITE_RESULT = ConfigWriteResult.parse({
  key: "advisor.enabled",
  layer: "global",
  folder: null,
  revision: "rev-8",
  previousRevision: "rev-7",
  entry: { key: "advisor.enabled", secret: false, value: false, source: "global", overrides: [] },
});

/** The answer to a write whose expected revision is stale: another change landed first, so nothing is written. */
export const ADVISOR_STALE_WRITE_CONFLICT = AppError.parse({
  code: "conflict",
  message: "This setting changed in another place. Reload it and try again.",
  retryable: false,
});

/**
 * A secret is described by whether it is set and which layer sets it, never by its value. The schema is
 * strict, so a value cannot ride along; fixtures.test.ts proves that. The key is synthetic: it is not one
 * of omp's advisor settings.
 */
export const REDACTED_SECRET_STATUS: ConfigEntry = ConfigEntry.parse({
  key: "fixture.token",
  secret: true,
  isSet: true,
  source: "global",
  overrides: [],
});
