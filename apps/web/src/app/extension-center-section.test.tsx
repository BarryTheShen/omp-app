import { describe, expect, test } from "vitest";
import { extensionCenterAvailable } from "./extension-center-section";

describe("the Tools tab's extension control center", () => {
  test("is offered only when the host serves the extension catalog", () => {
    expect(extensionCenterAvailable({})).toBe(false);
    expect(
      extensionCenterAvailable({ "host.extension-catalog": { state: "available", via: "rpc" } }),
    ).toBe(true);
  });
});
