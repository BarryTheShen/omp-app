import type { ConfigEntry, ConfigWriteResult, Revision } from "@omp-app/contracts";
import { AppFailure, ConfigWriteArgs, JsonValue } from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import { TOOLS_GITHUB_SECTION, TOOLS_OUTPUT_LIMITS_SECTION } from "../../sections";

type RuntimeFixture = {
  readonly runtime: SettingsRuntime;
  readonly entries: ConfigEntry[];
  readonly writes: ConfigWriteArgs[];
};

const activeRuntimes: SettingsRuntime[] = [];

afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) runtime.dispose();
});

function fixture(
  descriptor: SettingsSectionDescriptor,
  values: Readonly<Record<string, number>>,
): RuntimeFixture {
  let revision = "s3-cross-field-1" as Revision;
  const entries: ConfigEntry[] = Object.entries(values).map(([key, value]) => ({
    key,
    secret: false,
    value,
    source: "global",
    overrides: [],
  }));
  const writes: ConfigWriteArgs[] = [];
  const client: ConfigStoreClient = {
    async read({ key }) {
      const entry = entries.find((candidate) => candidate.key === key);
      if (entry) return entry;
      throw new AppFailure({ code: "not_found", message: "Setting not found.", retryable: false });
    },
    async list() {
      return { entries: [...entries], revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgs.parse(input);
      writes.push(args);
      if (args.expectedRevision !== revision) {
        throw new AppFailure({ code: "conflict", message: "Settings changed.", retryable: true });
      }
      if (args.value.secret) throw new Error("These controls are not secret settings.");
      const previousRevision = revision;
      revision = `s3-cross-field-${writes.length + 1}` as Revision;
      const entry: ConfigEntry = {
        key: args.key,
        secret: false,
        value: JsonValue.parse(args.value.value),
        source: args.layer,
        overrides: [],
      };
      const index = entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
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
  const source: ConfigChangeSource = { subscribe: () => () => undefined };
  const runtime = new SettingsRuntime(client, source, {
    descriptor,
    folder: null,
    layer: "global",
  });
  activeRuntimes.push(runtime);
  return { runtime, entries, writes };
}

describe("S3 cross-field rules through SettingsRuntime", () => {
  test("rejects soft 15 then hard 12 against the complete staged GitHub pair before writing", async () => {
    const state = fixture(TOOLS_GITHUB_SECTION, {
      "github.cache.softTtlSec": 10,
      "github.cache.hardTtlSec": 20,
    });
    await state.runtime.read();
    expect(state.runtime.stage("github.cache.softTtlSec", { secret: false, value: 15 }).ok).toBe(
      true,
    );
    expect(state.runtime.stage("github.cache.hardTtlSec", { secret: false, value: 12 }).ok).toBe(
      true,
    );

    await expect(state.runtime.save()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(state.writes).toHaveLength(0);
  });

  test("rejects head 30 then tail 30 when their staged total exceeds spill 50", async () => {
    const state = fixture(TOOLS_OUTPUT_LIMITS_SECTION, {
      "tools.artifactSpillThreshold": 50,
      "tools.artifactTailBytes": 20,
      "tools.artifactHeadBytes": 20,
    });
    await state.runtime.read();
    expect(state.runtime.stage("tools.artifactHeadBytes", { secret: false, value: 30 }).ok).toBe(
      true,
    );
    expect(state.runtime.stage("tools.artifactTailBytes", { secret: false, value: 30 }).ok).toBe(
      true,
    );

    await expect(state.runtime.save()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(state.writes).toHaveLength(0);
  });

  test("allows both GitHub TTLs to rise together in one save", async () => {
    const state = fixture(TOOLS_GITHUB_SECTION, {
      "github.cache.softTtlSec": 10,
      "github.cache.hardTtlSec": 20,
    });
    await state.runtime.read();
    expect(state.runtime.stage("github.cache.softTtlSec", { secret: false, value: 50 }).ok).toBe(
      true,
    );
    expect(state.runtime.stage("github.cache.hardTtlSec", { secret: false, value: 50 }).ok).toBe(
      true,
    );

    await expect(state.runtime.save()).resolves.toMatchObject({ status: "applied" });
    expect(state.writes).toHaveLength(2);
    expect(state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "github.cache.softTtlSec", value: 50 }),
        expect.objectContaining({ key: "github.cache.hardTtlSec", value: 50 }),
      ]),
    );
  });
});
