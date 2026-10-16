import { INVENTORY, namespaceClaim, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P4_INVENTORY_COVERS } from "../contract";
import { P4_DESCRIPTORS } from ".";

/** The two P3 rows that stay with P3: the previous-message selector and the branch summary divider. */
const P3_ROWS_KEPT = ["P3.branch-message-selector", "P3.branch-summary-divider"];

interface Claimant {
  readonly id: string;
  readonly owner: string;
  readonly covers: readonly string[];
}

/** What a descriptor list gets wrong against the owned rows, in plain words. An empty list means it is right. */
function coverageProblems(descriptors: readonly Claimant[], owned: readonly string[]): string[] {
  const covered = descriptors.flatMap((descriptor) => descriptor.covers);
  const problems = owned.flatMap((row) => {
    const times = covered.filter((item) => item === row).length;
    return times === 1 ? [] : [`${row} is covered ${times} times`];
  });
  problems.push(
    ...covered.filter((row) => !owned.includes(row)).map((row) => `${row} is not owned`),
  );
  for (const descriptor of descriptors) {
    if (!descriptor.id.startsWith("P4.")) problems.push(`${descriptor.id} is not prefixed P4.`);
    if (descriptor.owner !== "P4")
      problems.push(`${descriptor.id} is owned by ${descriptor.owner}`);
  }
  return problems;
}

describe("P4 descriptor coverage", () => {
  test("covers exactly the nine durable-tree rows the spec assigns to P4, each once", () => {
    const owned: readonly string[] = P4_INVENTORY_COVERS;
    const liveRows = INVENTORY.map((item) => item.id).filter((id) => owned.includes(id));

    expect([...liveRows].sort()).toEqual([...owned].sort());
    const covered = P4_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect([...covered].sort()).toEqual([...owned].sort());
    expect(liveRows).toHaveLength(9);
    expect(coverageProblems(P4_DESCRIPTORS, owned)).toEqual([]);
  });

  test("the inventory's P3 rows are the nine P4 rows plus the two P3 keeps, so no P3 row is unowned", () => {
    const p3Rows = INVENTORY.filter((item) => item.group === "P3").map((item) => item.id);

    expect([...p3Rows].sort()).toEqual([...P4_INVENTORY_COVERS, ...P3_ROWS_KEPT].sort());
  });

  test("every descriptor is owner-prefixed, and each namespace it claims belongs to P4 in the ownership table", () => {
    expect(
      P4_DESCRIPTORS.every(
        (descriptor) => descriptor.id.startsWith("P4.") && descriptor.owner === "P4",
      ),
    ).toBe(true);

    const slashCommands = P4_DESCRIPTORS.flatMap((descriptor) =>
      "slash" in descriptor && descriptor.slash?.source === "builtin"
        ? [`/${descriptor.slash.name}`]
        : [],
    );
    expect([...slashCommands].sort()).toEqual(["/branch", "/fork", "/tree"]);
    for (const namespace of slashCommands) {
      expect(namespaceClaim("slash-command", namespace)).toMatchObject({
        status: "owned",
        owner: "P4",
      });
    }
    expect(namespaceClaim("panel", "tree")).toMatchObject({
      status: "owned",
      owner: "P4",
    });
    expect(P4_DESCRIPTORS.find((descriptor) => descriptor.kind === "panel")).toMatchObject({
      id: "P4.tree",
      owner: "P4",
      title: "Conversation tree",
      covers: [],
    });
  });

  test("the P4 descriptor registry has no duplicate ids", () => {
    const ids = P4_DESCRIPTORS.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateRegistry(P4_DESCRIPTORS)).toEqual([]);
  });

  test("a removed owned row is reported, so a short list cannot pass", () => {
    const covering: readonly Claimant[] = [{ id: "P4.branch", owner: "P4", covers: ["P3.branch"] }];

    expect(coverageProblems(covering, ["P3.branch", "P3.tree-selector"])).toEqual([
      "P3.tree-selector is covered 0 times",
    ]);
  });

  test("a row covered twice, a row nobody owns, and a descriptor outside P4 are reported", () => {
    const doubled: readonly Claimant[] = [
      { id: "P4.first", owner: "P4", covers: ["P3.branch"] },
      { id: "P4.second", owner: "P4", covers: ["P3.branch", "P3.extra"] },
    ];
    expect(coverageProblems(doubled, ["P3.branch"])).toEqual([
      "P3.branch is covered 2 times",
      "P3.extra is not owned",
    ]);
    expect(
      coverageProblems([{ id: "P3.branch", owner: "P3", covers: ["P3.branch"] }], ["P3.branch"]),
    ).toEqual(["P3.branch is not prefixed P4.", "P3.branch is owned by P3"]);
  });
});
