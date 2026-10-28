import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAT_HOST_METHODS } from "@omp-app/contracts/chat-host";
import type { CapabilityProbeRawResult } from "./capabilities";
import { capabilityProbeResultFromRaw } from "./capabilities";
import { createConfigStoreWithOmpDefaults } from "./modules/A1/config/omp-defaults";
import { probeCacheIdentity, readProbeCache, writeProbeCache } from "./probe-cache";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  await mkdir(join(import.meta.dir, "../../../.data"), { recursive: true });
  const root = await mkdtemp(join(import.meta.dir, "../../../.data/probe-cache-test-"));
  roots.push(root);
  return root;
}

function rawResult(): CapabilityProbeRawResult {
  return {
    commandResults: Object.fromEntries(
      CHAT_HOST_METHODS.map((command) => [command, { available: true }]),
    ) as CapabilityProbeRawResult["commandResults"],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("omp probe cache", () => {
  test("round-trips omp results and rejects a changed environment or version", async () => {
    const root = await temporaryRoot();
    const binary = join(root, "omp");
    await writeFile(binary, "binary");
    const environment = {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_MODE: "test",
      OMP_APP_DATA_DIR: join(root, "app"),
    };
    const identity = await probeCacheIdentity([binary], "omp 18.12.2", environment);
    await writeProbeCache(root, identity, rawResult(), { model: "fake" }, ["model", "noDefault"]);

    await expect(readProbeCache(root, identity)).resolves.toMatchObject({
      raw: rawResult(),
      defaults: {
        loaded: {
          defaults: { model: "fake" },
          registryKeys: ["model", "noDefault"],
        },
      },
    });
    await expect(
      readProbeCache(
        root,
        await probeCacheIdentity([binary], "omp 18.12.2", { ...environment, PI_MODE: "changed" }),
      ),
    ).resolves.toBeUndefined();
    const changedTime = new Date(Date.now() + 60_000);
    await utimes(binary, changedTime, changedTime);
    await expect(
      readProbeCache(root, await probeCacheIdentity([binary], "omp 18.12.2", environment)),
    ).resolves.toBeUndefined();

    const cachePath = join(root, "omp-probe-cache.json");
    await writeFile(cachePath, '{"schema":2');
    await expect(readProbeCache(root, identity)).resolves.toBeUndefined();
    await writeProbeCache(root, identity, rawResult(), { model: "fake" }, ["model", "noDefault"]);
    const truncated = JSON.parse(await readFile(cachePath, "utf8")) as {
      capabilities: { commandResults: Record<string, unknown> };
    };
    delete truncated.capabilities.commandResults.get_state;
    await writeFile(cachePath, JSON.stringify(truncated));
    await expect(readProbeCache(root, identity)).resolves.toBeUndefined();
  });

  test("a result the RPC capability check cached (schema 2) is not read, so the chat host's check runs again", async () => {
    const root = await temporaryRoot();
    const binary = join(root, "omp");
    await writeFile(binary, "binary");
    const identity = await probeCacheIdentity([binary], "omp 18.12.6", {});
    await writeProbeCache(root, identity, rawResult(), { model: "fake" }, ["model"]);
    const cachePath = join(root, "omp-probe-cache.json");
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
    await writeFile(cachePath, JSON.stringify({ ...cached, schema: 2 }));
    await expect(readProbeCache(root, identity)).resolves.toBeUndefined();
  });

  test("a cache hit preserves available registry keys without defaults", async () => {
    const root = await temporaryRoot();
    const binary = join(root, "omp");
    await writeFile(binary, "binary");
    const environment = {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      OMP_APP_DATA_DIR: join(root, "app"),
    };
    const identity = await probeCacheIdentity([binary], "omp 18.12.2", environment);
    const defaults = {
      loaded: {
        defaults: { model: "fake" },
        registryKeys: ["model", "registry.only"],
      },
      leftover: false,
    } as const;
    await writeProbeCache(
      root,
      identity,
      rawResult(),
      defaults.loaded.defaults,
      defaults.loaded.registryKeys,
    );
    const hit = await readProbeCache(root, identity);
    expect(hit).toBeDefined();
    const configOptions = {
      agentDir: join(root, "agent"),
      appDataDir: join(root, "app-data"),
    };
    const probeOptions = {
      command: [binary],
      launchDirectory: root,
      pathEnvironment: process.env.PATH ?? "",
    };
    const missStore = await createConfigStoreWithOmpDefaults(configOptions, probeOptions, defaults);
    const hitStore = await createConfigStoreWithOmpDefaults(
      configOptions,
      probeOptions,
      hit?.defaults,
    );
    try {
      const miss = await missStore.list({ folder: null });
      const cached = await hitStore.list({ folder: null });
      expect(miss.availableKeys).toEqual(["model", "registry.only"]);
      expect(cached.availableKeys).toEqual(miss.availableKeys);
    } finally {
      missStore.dispose();
      hitStore.dispose();
    }
  });

  test("rebuilds host capabilities from current constants on a cache hit without a probe", async () => {
    const root = await temporaryRoot();
    const binary = join(root, "omp");
    await writeFile(binary, "binary");
    const identity = await probeCacheIdentity([binary], "omp 18.12.2", {});
    await writeProbeCache(root, identity, rawResult(), {}, []);
    const hit = await readProbeCache(root, identity);
    expect(hit).toBeDefined();
    const withoutConfig = capabilityProbeResultFromRaw(hit?.raw ?? rawResult(), {
      hostCapabilities: [],
    });
    const withConfig = capabilityProbeResultFromRaw(hit?.raw ?? rawResult(), {
      hostCapabilities: ["host.config"],
    });
    expect(withoutConfig.capabilities["host.config"]).toBeUndefined();
    expect(withConfig.capabilities["host.config"]).toEqual({ state: "available", via: "host" });
  });
});
