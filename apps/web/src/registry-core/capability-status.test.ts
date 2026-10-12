import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { capabilityStatus, UPSTREAM_UNAVAILABLE } from "./hooks";

describe("capabilityStatus", () => {
  test("an unreported upstream key is unavailable with the standing upstream reason", () => {
    expect(capabilityStatus({}, "upstream.session-archive")).toBe(UPSTREAM_UNAVAILABLE);
  });

  test("the server's report wins, including for an upstream key omp has started to ship", () => {
    const capabilities: CapabilityMap = {
      "upstream.session-archive": { state: "available", via: "rpc" },
      "host.drafts": { state: "fallback", via: "host", detail: "read-only" },
    };
    expect(capabilityStatus(capabilities, "upstream.session-archive")?.state).toBe("available");
    expect(capabilityStatus(capabilities, "host.drafts")?.detail).toBe("read-only");
  });

  test("the standing upstream reason says what to do, in plain words", () => {
    expect(UPSTREAM_UNAVAILABLE.detail).toBe("Needs a newer version of omp.");
  });

  test("any other unreported key stays unknown", () => {
    expect(capabilityStatus({}, "host.drafts")).toBeUndefined();
    expect(capabilityStatus({}, "omp.cmd.get_state")).toBeUndefined();
  });
});
