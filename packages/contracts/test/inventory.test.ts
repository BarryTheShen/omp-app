import { describe, expect, test } from "bun:test";
import { INVENTORY, INVENTORY_IDS } from "../src";

describe("inventory", () => {
  test("every row has its own id", () => {
    expect(INVENTORY_IDS.size).toBe(INVENTORY.length);
  });

  test("/agents and its dashboard are terminal-only, since omp registers /agents with handleTui alone", () => {
    const rpcById = new Map(INVENTORY.map((item) => [item.id, item.rpc] as const));
    expect(rpcById.get("P1.agents")).toBe("terminal-only");
    expect(rpcById.get("P1.agents-dashboard")).toBe("terminal-only");
  });
});
