import { CapabilityStatus } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ThinkingSelector } from "./selector";
import { ThinkingLevelsController } from "./thinking";

afterEach(cleanup);

const capabilities = {
  "omp.cmd.get_available_thinking_levels": CapabilityStatus.parse({
    state: "available",
    via: "rpc",
  }),
  "omp.cmd.set_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.cycle_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

const source = {
  getAvailableLevels: async () => ["low", "medium", "high"] as const,
  setLevel: async () => undefined,
  cycleLevel: async () => ({ level: "high" as const }),
};

describe("the thinking level card", () => {
  test("says what it changes in plain words, with no raw 'session' tag", async () => {
    const controller = new ThinkingLevelsController({ source, capabilities });
    try {
      render(<ThinkingSelector controller={controller} />);
      expect(await screen.findByRole("heading", { name: "Thinking level" })).toBeTruthy();
      expect(screen.getByText("Session reasoning depth")).toBeTruthy();
      expect(screen.queryByText("session", { exact: true })).toBeNull();
    } finally {
      controller.dispose();
    }
  });
});
