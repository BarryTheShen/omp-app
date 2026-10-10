import { describe, expect, test } from "vitest";
import { ShareVisibilitySchema } from "../contract";
import { SHARE_VISIBILITY } from "./visibility";

describe("the share visibility gate", () => {
  test("is the verified unavailable state for upstream.share-visibility", () => {
    expect(ShareVisibilitySchema.parse(SHARE_VISIBILITY)).toEqual(SHARE_VISIBILITY);
    expect(SHARE_VISIBILITY.state).toBe("unavailable");
    expect(SHARE_VISIBILITY.capability).toBe("upstream.share-visibility");
  });

  test("gives the reason in plain words, with no internal names", () => {
    expect(SHARE_VISIBILITY.reason).toContain("only make one kind of link");
    expect(SHARE_VISIBILITY.reason).toContain("Private and team links need omp to add them first");
    expect(SHARE_VISIBILITY.reason).not.toMatch(/upstream|capability|RPC/);
  });
});
