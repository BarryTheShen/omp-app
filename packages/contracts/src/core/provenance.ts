/**
 * Where a value came from.
 *
 * `SettingSource` is omp's own settings layering (omp v18.6.1; paths under
 * `packages/coding-agent/src/` unless noted). omp reports these layer names itself
 * (`SettingProvenance`, config/settings.ts:63-64) and resolves a setting's value as follows:
 * - `env` wins over every layer when the setting declares an environment variable, unless the
 *   variable is declared a fallback, in which case any configured layer wins over it and it only
 *   replaces the default (config/registry.ts:65-83, 525-539, 789-792).
 * - Otherwise the configured layers, highest first: `runtime` → `overlay` → `project` → `global`,
 *   then the schema `default` (config/settings.ts:864-877, 3826-3831). Objects merge key by key;
 *   arrays and scalars are replaced whole by the higher layer (config/settings.ts:3850-3873). A
 *   value that merges to `null` counts as unset.
 *
 * omp exposes only the layer, never the file that supplied it; when A1 reads the files itself it
 * fills `Provenance.path`. There is no managed or system-wide settings layer in omp 18.6.1.
 */
import { z } from "zod";
import { EntryId } from "./ids";

/** omp's settings layers, highest precedence first (a fallback `env` ranks just above `default`). */
export const SETTING_SOURCES = [
  /** An environment variable the setting declares. */
  "env",
  /**
   * In-memory overrides of this process, never written to disk: session-scoped RPC changes such as
   * `set_auto_compaction` and `set_auto_retry` (docs/rpc.md:1010-1013), CLI flags such as
   * `--approval-mode` (main.ts:1849-1857), and the soft defaults omp pins in RPC/ACP mode for
   * settings marked `protocolDefault` unless a layer configures them (config/registry.ts:102-107,
   * config/settings.ts:991-1002, main.ts:246-255 and 1858-1862).
   */
  "runtime",
  /** Files named by `PI_CONFIG_FILES`, then by `--config`, merged in that order (config/settings.ts:661-663). */
  "overlay",
  /**
   * Project settings from omp's settings capability, `level: "project"` items only: native
   * `<cwd>/.omp/config.yml` and `.omp/settings.json`, plus `.claude/settings.json`,
   * `.codex/config.toml`, `.gemini/settings.json` and `opencode.json(c)` (config/settings.ts:2346-2384,
   * discovery/{builtin,claude,codex,gemini,opencode}.ts).
   */
  "project",
  /**
   * The user's `config.yml` (`config.yaml` as fallback) in omp's agent folder: `~/.omp/agent` by
   * default, `~/.omp/profiles/<profile>/agent` under `OMP_PROFILE`, or `PI_CODING_AGENT_DIR`
   * (config/settings.ts:659-660; packages/utils/src/dirs.ts:1-12, 28-31, 83-96, 311-315, 342-349).
   */
  "global",
  /** The setting's schema default. */
  "default",
] as const;
export const SettingSource = z.enum(SETTING_SOURCES);
export type SettingSource = z.infer<typeof SettingSource>;

/** Who produced a value the app shows. */
export const PROVENANCE_ORIGINS = [
  /** A response or event of the running omp process. */
  "omp-rpc",
  /** Read from an omp session file by the server (A1). */
  "omp-session-file",
  /** Read from omp's settings files by the server (A1). */
  "omp-config",
  /** The app's own stores: drafts, checkpoints, app preferences. */
  "app-store",
  /** Replayed from a recorded fixture. */
  "fixture",
  /** Computed by the app server where omp's RPC cannot reach (AP3, AP4, AP6 fallbacks). */
  "host-fallback",
  /** Browser-only state (AP5). */
  "client",
] as const;
export const ProvenanceOrigin = z.enum(PROVENANCE_ORIGINS);
export type ProvenanceOrigin = z.infer<typeof ProvenanceOrigin>;

export const Provenance = z.object({
  origin: ProvenanceOrigin,
  /** The omp version that produced or wrote the value. */
  ompVersion: z.string().optional(),
  /** The file the value was read from (absolute on the server; a placeholder path in fixtures). */
  path: z.string().optional(),
  /** The session entry the value was read from. */
  entryId: EntryId.optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * omp's two precedence orders, highest first. An environment variable normally wins over every
 * layer; one the setting declares a fallback only replaces the default, so it ranks just above
 * `default` (config/registry.ts:65-83, 525-539).
 */
const PRECEDENCE_ORDERS: readonly (readonly SettingSource[])[] = [
  SETTING_SOURCES,
  ["runtime", "overlay", "project", "global", "env", "default"],
];

/**
 * Whether `overrides` lists only layers below `source`, each once and highest first, in one of
 * omp's two precedence orders.
 */
export function overridesFollowPrecedence(
  source: SettingSource,
  overrides: readonly SettingSource[],
): boolean {
  return PRECEDENCE_ORDERS.some((order) => {
    let previous = order.indexOf(source);
    for (const layer of overrides) {
      const index = order.indexOf(layer);
      if (index <= previous) return false;
      previous = index;
    }
    return true;
  });
}

/** A value plus the layer it came from and the lower layers that also set it but lost. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: SettingSource;
  /**
   * Layers that also configure the key and are overridden: each strictly below `source`, listed
   * once, highest first (`overridesFollowPrecedence`). An `env` variable that lost to a
   * configured layer must be a fallback one, so it ranks after `global`, just above `default`:
   * `["env", "default"]` under a `global` source.
   */
  readonly overrides: readonly SettingSource[];
  readonly provenance?: Provenance;
}

/** The schema of `Sourced<T>` for a value schema. */
export function sourcedSchema<Value extends z.ZodType>(value: Value) {
  return z
    .object({
      value,
      source: SettingSource,
      overrides: z.array(SettingSource),
      provenance: Provenance.optional(),
    })
    .refine(
      (sourced) => overridesFollowPrecedence(sourced.source, sourced.overrides),
      "overrides must list lower layers only, each once, highest first",
    );
}
