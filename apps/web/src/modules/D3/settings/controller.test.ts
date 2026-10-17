import type { AppClient } from "@omp-app/client";
import type {
  ConfigEntry,
  ConfigListResult,
  ConfigWriteArgs,
  ConfigWriteResult,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createProviderSettingsController } from "./controller";

function fakeEntry(key: string, value: string | number | boolean): ConfigEntry {
  return { key, secret: false, value, source: "global", overrides: [] };
}

function fakeAppClient() {
  let entries: ConfigEntry[] = [fakeEntry("providers.fireworksTier", "standard")];
  let revision = 0;
  const list = vi.fn(
    async (): Promise<ConfigListResult> => ({
      entries,
      revision: `revision-${revision}`,
    }),
  );
  const write = vi.fn(async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
    const entry = {
      ...args.value,
      key: args.key,
      source: "global" as const,
      overrides: [],
    } as ConfigEntry;
    entries = [...entries.filter((candidate) => candidate.key !== args.key), entry];
    const previousRevision = `revision-${revision}`;
    revision += 1;
    return {
      key: args.key,
      layer: "global",
      folder: null,
      revision: `revision-${revision}`,
      previousRevision,
      entry,
    };
  });
  const port = () => ({ list, read: vi.fn(), write });
  const client = {
    port,
    subscribe: vi.fn(async () => ({ unsubscribe: async () => undefined })),
  } as unknown as AppClient;
  return { client, list, write };
}

describe("provider settings controller", () => {
  test("loads all five sections through the typed config client and disposes runtimes", async () => {
    const fake = fakeAppClient();
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    await controller.runtime("D3.providerFireworks").read();
    expect(fake.list).toHaveBeenCalledWith({ folder: null });
    expect(controller.descriptors).toHaveLength(5);
    controller.select("D3.providerPrivacy");
    expect(controller.selectedSectionId()).toBe("D3.providerPrivacy");
    controller.dispose();
  });

  test("saves one validated setting and preserves the global write layer", async () => {
    const fake = fakeAppClient();
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    expect(
      runtime.stage("providers.fireworksTier", { secret: false, value: "priority" }),
    ).toMatchObject({
      ok: true,
    });
    await runtime.save();
    expect(fake.write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "providers.fireworksTier",
        layer: "global",
        folder: null,
        value: { secret: false, value: "priority" },
      }),
    );
    const protocol = controller.runtime("D3.providerProtocol");
    await protocol.read();
    protocol.stage("provider.appendOnlyContext", { secret: false, value: "on" });
    await protocol.save();
    expect(fake.write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "provider.appendOnlyContext",
        value: { secret: false, value: "on" },
      }),
    );
    controller.dispose();
  });
});
