import type { ConfigEntry, Revision } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  type ConfigSnapshot,
  type ConfigStoreClient,
  commit,
  type SettingControl,
  type SettingsSectionDescriptor,
  settingAvailability,
  stage,
} from "../../settings-kit";

const revision = "availability-revision" as Revision;
const control: SettingControl = {
  key: "example.setting",
  label: "Example setting",
  kind: "boolean",
  secret: false,
  apply: "live",
  validate: () => ({ valid: true }),
};
const descriptor: SettingsSectionDescriptor = {
  id: "S1.interaction-input",
  section: "interaction/Input",
  title: "Input",
  inventory: ["S3.interaction-input"],
  controls: [control],
  requires: [],
};

function snapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    folder: null,
    revision,
    entries: [],
    ...overrides,
  };
}

const availableEntry = (): ConfigEntry => ({
  key: "example.setting",
  secret: false,
  value: true,
  source: "project",
  overrides: [],
});

describe("settings availability", () => {
  test("recognizes present keys, missing loaded keys, and unknown defaults", () => {
    expect(
      settingAvailability(snapshot({ availableKeys: ["example.setting"] }), "example.setting"),
    ).toBe("available");
    expect(settingAvailability(snapshot({ availableKeys: [] }), "example.setting")).toBe(
      "unavailable",
    );
    expect(settingAvailability(snapshot({}), "example.setting")).toBe("unknown");
    expect(settingAvailability(snapshot({ availableKeys: undefined }), "example.setting")).toBe(
      "unknown",
    );
  });

  test("a secret key and a project-layer key remain available when omp reports them", () => {
    const reported = snapshot({
      availableKeys: ["example.setting"],
      entries: [
        {
          key: "example.setting",
          secret: true,
          isSet: true,
          source: "project",
          overrides: [],
        },
        availableEntry(),
      ],
    });
    expect(settingAvailability(reported, "example.setting")).toBe("available");
  });

  test("stage refuses an unavailable key with a plain sentence", () => {
    const state = { snapshot: snapshot({ availableKeys: [] }), edits: {} };
    expect(stage(descriptor, state, control.key, { secret: false, value: true })).toEqual({
      ok: false,
      validation: {
        valid: false,
        code: "unavailable",
        message: "This omp version does not have this setting.",
      },
    });
  });

  test("commit refuses an unavailable key before ConfigStore write", async () => {
    const writes: string[] = [];
    const client: ConfigStoreClient = {
      read: async () => availableEntry(),
      list: async () => ({ entries: [], revision }),
      write: async (args) => {
        writes.push(args.key);
        return {
          key: args.key,
          layer: args.layer,
          folder: null,
          revision,
          previousRevision: revision,
          entry: availableEntry(),
        };
      },
    };
    await expect(
      commit(
        client,
        descriptor,
        {
          snapshot: snapshot({ availableKeys: [] }),
          edits: { [control.key]: { secret: false, value: true } },
        },
        "global",
      ),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    expect(writes).toEqual([]);
  });
});
