import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { INVENTORY_SOURCE, inventoryJson, parseInventory } from "../scripts/build-inventory";
import { INVENTORY, INVENTORY_IDS } from "../src";

const markdown = await Bun.file(INVENTORY_SOURCE).text();

/**
 * Counts from a "- By …:" line of the research file's Totals, such as "366 RPC, 0 main only".
 * Categories stated as 0 are left out: a tally of rows has no key for a category without rows.
 */
function statedCounts(prefix: string): Record<string, number> {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`no "${prefix}" line`);
  return Object.fromEntries(
    [...line.matchAll(/(\d+) ([a-z-]+)/gi)]
      .map(([, count = "", label = ""]) => [label, Number(count)] as const)
      .filter(([, count]) => count > 0),
  );
}

function tally(values: readonly string[]): Record<string, number | undefined> {
  const counts: Record<string, number | undefined> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

describe("inventory", () => {
  test("has as many rows as the research file's header line states, with unique ids", () => {
    const stated = /^Generated .*?\. (\d+) items:/m.exec(markdown)?.[1];
    expect(stated).toBeDefined();
    expect(INVENTORY).toHaveLength(Number(stated));
    expect(INVENTORY_IDS.size).toBe(INVENTORY.length);
  });

  test("inventory.json is what the script builds from the research file", async () => {
    const { rows, problems } = parseInventory(markdown);
    expect(problems).toEqual([]);
    const committed = await Bun.file(
      join(import.meta.dir, "..", "src", "core", "inventory.json"),
    ).text();
    expect(committed).toBe(inventoryJson(rows));
  });

  test("matches the research file's totals by rpc status and by kind", () => {
    expect(tally(INVENTORY.map((item) => item.rpc))).toEqual(statedCounts("- By rpc:"));
    expect(tally(INVENTORY.map((item) => item.kind))).toEqual(statedCounts("- By kind:"));
  });

  test("/agents and its dashboard are terminal-only, since omp registers /agents with handleTui alone", () => {
    const rpcById = new Map(INVENTORY.map((item) => [item.id, item.rpc] as const));
    expect(rpcById.get("P1.agents")).toBe("terminal-only");
    expect(rpcById.get("P1.agents-dashboard")).toBe("terminal-only");
  });
});
