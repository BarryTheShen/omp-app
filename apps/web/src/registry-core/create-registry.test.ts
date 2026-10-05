import { AppFailure, type Descriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createRegistry } from "./index";

const base = { title: "Example", covers: [], requires: [] };

describe("createRegistry", () => {
  test("indexes a valid registry by id and by kind", () => {
    const dialog: Descriptor = { ...base, id: "U0.confirm", owner: "U0", kind: "dialog" };
    const status: Descriptor = { ...base, id: "U0.connection", owner: "U0", kind: "status" };

    const registry = createRegistry([dialog, status]);

    expect(registry.descriptors).toEqual([dialog, status]);
    expect(registry.byId.get("U0.confirm")).toBe(dialog);
    expect(registry.byId.get("U0.connection")).toBe(status);
    expect(registry.byKind.get("dialog")).toEqual([dialog]);
    expect(registry.byKind.get("status")).toEqual([status]);
    expect(registry.byKind.get("panel")).toBeUndefined();
  });

  test("accepts an empty registry", () => {
    const registry = createRegistry([]);
    expect(registry.descriptors).toEqual([]);
    expect(registry.byKind.size).toBe(0);
  });

  test("rejects a duplicate id and a double claim, listing every problem", () => {
    const toolA: Descriptor = {
      ...base,
      id: "U0.open",
      owner: "U0",
      kind: "tool",
      match: { by: "name", name: "open" },
    };
    const toolB: Descriptor = {
      ...base,
      id: "U0.open",
      owner: "U0",
      kind: "tool",
      match: { by: "name", name: "open" },
    };

    let caught: unknown;
    try {
      createRegistry([toolA, toolB]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppFailure);
    const failure = caught as AppFailure;
    expect(failure.appError.code).toBe("internal");
    expect(failure.appError.retryable).toBe(false);
    expect(failure.appError.message).toContain("2 registry problems");
    expect(failure.appError.message).toContain("duplicate-id U0.open");
    expect(failure.appError.message).toContain("double-claim U0.open");
  });
});
