import { describe, expect, test } from "vitest";
import * as d6 from "../index";

describe("the D6 barrel", () => {
  test("exports contracts, descriptors, fallback fixtures and finished public seams", () => {
    expect(d6).toHaveProperty("D6_DESCRIPTORS");
    expect(d6).toHaveProperty("D6_FALLBACK_FIXTURES");
    expect(d6).toHaveProperty("DiagnosticCommandResultSchema");
    expect(d6).toHaveProperty("operationsViews");
    expect(d6).toHaveProperty("ReportsPanel");
    expect(d6).toHaveProperty("SecurityPanel");
    expect(d6).toHaveProperty("openDebugSelector");
  });
});
