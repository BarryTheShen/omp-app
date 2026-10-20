import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OMP_COMMAND_NAMES } from "@omp-app/contracts";
import { z } from "zod";
import type { CapabilityProbeRawResult } from "./capabilities";
import type { OmpDefaultsProbeResult } from "./modules/A1/config/omp-defaults";

const CACHE_SCHEMA = 2;
const CACHE_FILE = "omp-probe-cache.json";

export type ProbeCacheIdentity = {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly version: string;
  readonly environmentHash: string;
};

type CacheFile = {
  readonly schema: number;
  readonly identity: ProbeCacheIdentity;
  readonly capabilities: CapabilityProbeRawResult;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly registryKeys: readonly string[];
};

export interface ProbeCacheHit {
  readonly raw: CapabilityProbeRawResult;
  readonly defaults: OmpDefaultsProbeResult;
}

const CacheFileSchema = z.object({
  schema: z.literal(CACHE_SCHEMA),
  identity: z.object({
    path: z.string(),
    size: z.number(),
    mtimeMs: z.number(),
    version: z.string(),
    environmentHash: z.string(),
  }),
  capabilities: z.object({
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    commandResults: z.record(
      z.string(),
      z.object({ available: z.boolean(), reason: z.string().optional() }),
    ),
  }),
  defaults: z.record(z.string(), z.unknown()),
  registryKeys: z.array(z.string()),
});

function probeEnvironmentHash(environment: Readonly<Record<string, string>>): string {
  const values = Object.entries(environment)
    .filter(
      ([key]) => (key.startsWith("PI_") || key.startsWith("OMP_")) && key !== "OMP_APP_DATA_DIR",
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function binaryIdentity(
  binary: string,
): Promise<Pick<ProbeCacheIdentity, "path" | "size" | "mtimeMs">> {
  const path = await realpath(binary).catch(() => resolve(binary));
  const metadata = await stat(path);
  return { path, size: metadata.size, mtimeMs: metadata.mtimeMs };
}

export async function probeCacheIdentity(
  binary: string,
  version: string,
  environment: Readonly<Record<string, string>>,
): Promise<ProbeCacheIdentity> {
  const identity = await binaryIdentity(binary);
  return { ...identity, version, environmentHash: probeEnvironmentHash(environment) };
}

export async function readProbeCache(
  appDataDir: string,
  expected: ProbeCacheIdentity,
): Promise<ProbeCacheHit | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(appDataDir, CACHE_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const parsed = CacheFileSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { identity } = parsed.data;
  if (
    identity.path !== expected.path ||
    identity.size !== expected.size ||
    identity.mtimeMs !== expected.mtimeMs ||
    identity.version !== expected.version ||
    identity.environmentHash !== expected.environmentHash
  )
    return undefined;
  for (const command of OMP_COMMAND_NAMES) {
    if (parsed.data.capabilities.commandResults[command] === undefined) return undefined;
  }
  return {
    raw: parsed.data.capabilities as CapabilityProbeRawResult,
    defaults: {
      loaded: {
        defaults: parsed.data.defaults,
        registryKeys: parsed.data.registryKeys,
      },
      leftover: false,
    },
  };
}

export async function writeProbeCache(
  appDataDir: string,
  identity: ProbeCacheIdentity,
  raw: CapabilityProbeRawResult,
  defaults: Readonly<Record<string, unknown>>,
  registryKeys: readonly string[],
): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  const target = resolve(appDataDir, CACHE_FILE);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload: CacheFile = {
    schema: CACHE_SCHEMA,
    identity,
    capabilities: raw,
    defaults,
    registryKeys,
  };
  await writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}
