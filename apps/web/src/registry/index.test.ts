import { describe, expect, test } from "vitest";
import { DESCRIPTORS, RENDERERS, registry } from "./index";

describe("the initial composition index", () => {
  test("ships empty: the main agent fills it in as each module's descriptors and renderers merge", () => {
    expect(DESCRIPTORS).toEqual([]);
    expect(RENDERERS).toEqual({});
    expect(registry.descriptors).toEqual([]);
    expect(registry.byId.size).toBe(0);
  });
});
