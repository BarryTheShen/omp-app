import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { D4_DESCRIPTORS } from "./descriptors";

/** The D5 rows of the C0 inventory: each one is D4's to cover, exactly once. */
const D5_ROWS = INVENTORY.filter((item) => item.group === "D5")
  .map((item) => item.id)
  .sort();

describe("D4's composed descriptors", () => {
  test("pass the registry check with no problems", () => {
    expect(validateRegistry(D4_DESCRIPTORS)).toEqual([]);
  });

  test("cover each of the eight D5 rows exactly once: copy, share, the conversation picker and the five export rows", () => {
    expect(D5_ROWS).toHaveLength(8);
    const covered: readonly string[] = D4_DESCRIPTORS.flatMap((descriptor) => [
      ...descriptor.covers,
    ]).sort();
    expect(covered).toEqual(D5_ROWS);
  });

  test("claim the six D4 slash names, each once: copy, share, export, dump, open and record", () => {
    const names = D4_DESCRIPTORS.flatMap((descriptor) =>
      "slash" in descriptor && descriptor.slash !== undefined ? [descriptor.slash.name] : [],
    ).sort();
    expect(names).toEqual(["copy", "dump", "export", "open", "record", "share"]);
  });

  test("every descriptor belongs to D4, and the copy command keeps the id its handler runs", () => {
    expect(D4_DESCRIPTORS.every((descriptor) => descriptor.owner === "D4")).toBe(true);
    expect(D4_DESCRIPTORS.map((descriptor) => descriptor.id)).toContain("D4.copyFromChat");
  });

  test("are mounted in the app registry, so a mount that drops them fails here", () => {
    for (const descriptor of D4_DESCRIPTORS) expect(DESCRIPTORS).toContain(descriptor);
  });
});
