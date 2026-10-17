import type { ConfigEntry, ConfigWriteResult, Revision } from "@omp-app/contracts";
import { ConfigWriteArgs } from "@omp-app/contracts";
import { expect, test } from "vitest";
import { SettingsRuntime } from "@/modules/S1/runtime";
import type { ConfigStoreClient } from "@/modules/S1/settings-kit";
import { readSection } from "@/modules/S1/settings-kit";
import { modelRetryFallbackSection } from "../../settings/descriptors";

test("saves and reads back retry.fallbackChains through ConfigStore", async () => {
  let revision = "d1-initial" as Revision;
  let entry: ConfigEntry | undefined;
  const writes: ConfigWriteArgs[] = [];
  const client: ConfigStoreClient = {
    async read() {
      if (entry === undefined) throw new Error("No fallback chain has been saved yet.");
      return entry;
    },
    async list() {
      return { entries: entry === undefined ? [] : [entry], revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgs.parse(input);
      writes.push(args);
      if (args.value.secret) throw new Error("Fallback chains must not be saved as secrets.");
      const previousRevision = revision;
      revision = `d1-config-${writes.length}` as Revision;
      entry = {
        key: args.key,
        secret: false,
        value: args.value.value,
        source: args.layer,
        overrides: [],
      };
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        previousRevision,
        revision,
        entry,
      };
    },
  };
  const runtime = new SettingsRuntime(
    client,
    { subscribe: () => () => undefined },
    { descriptor: modelRetryFallbackSection, folder: null, layer: "global" },
  );
  try {
    await runtime.read();
    const chain = { default: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"] };
    expect(runtime.stage("retry.fallbackChains", { secret: false, value: chain }).ok).toBe(true);
    await runtime.save();

    expect(runtime.getSnapshot().applyStatus).toBe("applied");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      key: "retry.fallbackChains",
      layer: "global",
      value: { secret: false, value: chain },
    });
    const reloaded = await readSection(client, modelRetryFallbackSection, null);
    const saved = reloaded.entries.find((candidate) => candidate.key === "retry.fallbackChains");
    if (!saved || saved.secret) throw new Error("Saved fallback chain is missing or secret.");
    expect(saved.value).toEqual(chain);
  } finally {
    runtime.dispose();
  }
});
