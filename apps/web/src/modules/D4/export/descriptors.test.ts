import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { EXPORT_COMMAND_DESCRIPTORS } from "./descriptors";

describe("EXPORT_COMMAND_DESCRIPTORS", () => {
  test("validate in the app registry with no problems", () => {
    expect(validateRegistry(EXPORT_COMMAND_DESCRIPTORS)).toEqual([]);
  });

  test("cover the five export inventory rows, each exactly once", () => {
    const covered = EXPORT_COMMAND_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect([...covered].sort()).toEqual([
      "D5.dump",
      "D5.dump-all",
      "D5.export",
      "D5.open",
      "D5.record",
    ]);
  });

  test("claim only D4's slash names, and /dump all has none of its own", () => {
    const slashNames = EXPORT_COMMAND_DESCRIPTORS.flatMap((descriptor) =>
      "slash" in descriptor && descriptor.slash !== undefined ? [descriptor.slash.name] : [],
    );
    expect([...slashNames].sort()).toEqual(["dump", "export", "open", "record"]);
    expect(EXPORT_COMMAND_DESCRIPTORS.every((descriptor) => descriptor.owner === "D4")).toBe(true);
  });
});
