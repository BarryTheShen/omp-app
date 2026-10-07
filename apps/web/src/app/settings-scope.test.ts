import { ConfigWriteArgs, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { layerFolder } from "./settings-scope";

const folder = FolderPath.parse("/workspace/project");

/** A write of one value to `layer`, with the folder a settings screen would send. */
function writeTo(layer: "global" | "project", sentWith: typeof folder | null) {
  return ConfigWriteArgs.safeParse({
    key: "steeringMode",
    layer,
    value: { secret: false, value: "all" },
    folder: sentWith,
    expectedRevision: null,
  });
}

describe("layerFolder", () => {
  test("gives every layer the folder the config store accepts a write with", () => {
    expect(writeTo("global", layerFolder("global", folder)).success).toBe(true);
    expect(writeTo("project", layerFolder("project", folder)).success).toBe(true);
  });

  test("the open folder on a global write is what the store refuses (the 'Invalid port arguments' of a save)", () => {
    expect(writeTo("global", folder).success).toBe(false);
  });

  test("global settings have no folder, project settings keep the open one", () => {
    expect(layerFolder("global", folder)).toBeNull();
    expect(layerFolder("project", folder)).toBe(folder);
    expect(layerFolder("project", null)).toBeNull();
  });
});
