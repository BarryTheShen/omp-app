import { type CapabilityMap, CapabilityStatus } from "@omp-app/contracts";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import type { CancelAction } from "./controller";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));

describe("the live playground cancellation gate", () => {
  let cancelFor: (capabilities: CapabilityMap, subagents: SubagentClient) => CancelAction;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="p1-5-hub-live-root"></div>';
    // The entry module attaches to this root during evaluation, so import it only after setting up the DOM.
    ({ cancelFor } = await import("./live-playground"));
  });

  test("uses a fallback cancellation capability but rejects an unavailable one", () => {
    const subagents = {} as SubagentClient;
    const fallback: CapabilityMap = {
      [P1CapabilityKeys.cancel]: CapabilityStatus.parse({
        state: "fallback",
        via: "rpc",
        detail: "Cancellation is supplied by the host.",
      }),
    };
    const unavailable: CapabilityMap = {
      [P1CapabilityKeys.cancel]: CapabilityStatus.parse({
        state: "unavailable",
        via: "rpc",
        detail: "Cancellation is unavailable.",
      }),
    };

    expect(cancelFor(fallback, subagents).state).toBe("available");
    expect(cancelFor(unavailable, subagents)).toEqual({
      state: "unavailable",
      reason: "This omp cannot cancel workers.",
    });
  });

  test("rejects a host that reports no cancellation capability at all", () => {
    expect(cancelFor({}, {} as SubagentClient)).toEqual({
      state: "unavailable",
      reason: "This omp cannot cancel workers.",
    });
  });
});
