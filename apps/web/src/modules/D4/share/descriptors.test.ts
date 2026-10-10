import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D4_SHARE_DESCRIPTORS } from "./descriptors";

describe("the share palette command", () => {
  test("passes the registry check with no problems", () => {
    expect(validateRegistry(D4_SHARE_DESCRIPTORS)).toEqual([]);
  });

  test("covers the share inventory row once, and claims the share slash name", () => {
    expect(D4_SHARE_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual(["D5.share"]);
    expect(D4_SHARE_DESCRIPTORS).toMatchObject([
      {
        id: "D4.shareChat",
        owner: "D4",
        title: "Share this chat",
        slash: { name: "share", source: "builtin" },
      },
    ]);
  });

  test("needs the command gateway, and never the visibility gate, so that gate cannot disable sharing", () => {
    expect(D4_SHARE_DESCRIPTORS).toMatchObject([{ requires: ["host.command-gateway"] }]);
  });
});
