import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { RECORDED_COMMANDS } from "../fixtures/captures";
import { D2_DESCRIPTORS, D2_SOURCE_DESCRIPTORS } from "../index";

/** The rows this module answers: the seven D3 rows (command palette and slash menu) and the five D7 rows (mentions and autocomplete). */
const ROWS = INVENTORY.map((item) => item.id).filter(
  (id) => id.startsWith("D3.") || id.startsWith("D7."),
);

/** Whether a descriptor covers the inventory row: `covers` is a list of ids, whatever literal types its tuple holds. */
function coversRow(descriptor: { readonly covers: readonly string[] }, row: string): boolean {
  return descriptor.covers.includes(row);
}

describe("D2's descriptors cover the D3 and D7 inventory rows", () => {
  test("the twelve rows are the seven D3 rows and the five D7 rows", () => {
    expect(ROWS.filter((id) => id.startsWith("D3."))).toHaveLength(7);
    expect(ROWS.filter((id) => id.startsWith("D7."))).toHaveLength(5);
  });

  test("each row is covered by exactly one of D2's descriptors, and no other row is covered", () => {
    const covered = D2_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect([...covered].sort()).toEqual([...ROWS].sort());
  });

  test("D2's descriptors pass the registry check under the ownership table (ids, owners, claims, namespaces)", () => {
    expect(validateRegistry(D2_DESCRIPTORS)).toEqual([]);
  });

  test("every command source a descriptor names is one omp lists in the recording", () => {
    const listed = new Set<string>(
      RECORDED_COMMANDS.map((entry) => (entry as { source: string }).source),
    );
    for (const descriptor of D2_SOURCE_DESCRIPTORS) {
      if (!("slash" in descriptor)) continue;
      expect(listed.has(descriptor.slash.source), descriptor.id).toBe(true);
    }
  });

  test("the prompt-template descriptor claims no command, because omp listed neither template the recording wrote", () => {
    const templates = D2_SOURCE_DESCRIPTORS.find((descriptor) =>
      coversRow(descriptor, "D3.prompt-template"),
    );
    if (templates === undefined) throw new Error("no descriptor covers D3.prompt-template");
    expect("slash" in templates).toBe(false);
    const names = RECORDED_COMMANDS.map((entry) => (entry as { name: string }).name);
    expect(names).not.toContain("project-note");
    expect(names).not.toContain("global-note");
  });
});
