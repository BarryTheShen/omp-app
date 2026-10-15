import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { D4_DESCRIPTORS } from "./descriptors";

/** The D5 rows of the C0 inventory: each one is D4's to cover, exactly once. */
const D5_ROWS = INVENTORY.filter((item) => item.group === "D5")
  .map((item) => item.id)
  .sort();

/** The D5 rows whose commands are mounted today: copy (`D4.copyFromChat`) and share (`D4.shareChat`). */
const MOUNTED_ROWS = ["D5.conversation-copy-selector", "D5.copy", "D5.share"];

/** The export rows, which stay uncovered until their commands are mounted (follow-up issue 1683). */
const UNMOUNTED_ROWS = ["D5.dump", "D5.dump-all", "D5.export", "D5.open", "D5.record"];

describe("D4's composed descriptors", () => {
  test("pass the registry check with no problems", () => {
    expect(validateRegistry(D4_DESCRIPTORS)).toEqual([]);
  });

  test("cover the three D5 rows whose commands are mounted, each exactly once; the five export rows stay uncovered", () => {
    expect(D5_ROWS).toHaveLength(8);
    const covered: readonly string[] = D4_DESCRIPTORS.flatMap((descriptor) => [
      ...descriptor.covers,
    ]).sort();
    expect(covered).toEqual(MOUNTED_ROWS);
    expect(D5_ROWS.filter((row) => !covered.includes(row))).toEqual(UNMOUNTED_ROWS);
  });

  test("claim the two D4 slash names that are mounted today, each once: copy and share", () => {
    const names = D4_DESCRIPTORS.flatMap((descriptor) =>
      "slash" in descriptor && descriptor.slash !== undefined ? [descriptor.slash.name] : [],
    ).sort();
    expect(names).toEqual(["copy", "share"]);
  });

  test("every descriptor belongs to D4, and the copy command keeps the id its handler runs", () => {
    expect(D4_DESCRIPTORS.every((descriptor) => descriptor.owner === "D4")).toBe(true);
    expect(D4_DESCRIPTORS.map((descriptor) => descriptor.id)).toContain("D4.copyFromChat");
  });

  test("are mounted in the app registry, so a mount that drops them fails here", () => {
    for (const descriptor of D4_DESCRIPTORS) expect(DESCRIPTORS).toContain(descriptor);
  });
});
