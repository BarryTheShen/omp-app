import {
  ToolAvailabilityMode as ContractToolAvailabilityMode,
  ToolAvailabilityState as ContractToolAvailabilityState,
  ToolsAvailabilityResult,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { ExecutionMode, ToolAvailability, ToolAvailabilityState } from "../contract/models";

describe("A1 and D7 tool availability contracts", () => {
  test("accepts A1 rows with D7's state and mode enums", () => {
    const contract = ToolsAvailabilityResult.parse({
      tools: [
        { tool: "read", state: "available" },
        { tool: "ast_edit", state: "fallback" },
        { tool: "debug", state: "unavailable", mode: "computer" },
        { tool: "vision", state: "unknown" },
      ],
    });
    const d7 = ToolAvailability.array().parse(contract.tools);
    expect(d7).toEqual(contract.tools);
    expect(ToolAvailabilityState.options).toEqual(ContractToolAvailabilityState.options);
    expect(ExecutionMode.options).toEqual(ContractToolAvailabilityMode.options);
  });
});
