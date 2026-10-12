import type { MessageState } from "@assistant-ui/react";
import { describe, expect, test } from "vitest";
import { storeKeyOf } from "./store-key";

function row(id: string, custom: Record<string, unknown>): MessageState {
  return { id, metadata: { custom } } as unknown as MessageState;
}

describe("storeKeyOf", () => {
  test("a row whose id is its streamed copy's key reports the store key of its entry", () => {
    expect(storeKeyOf(row("stream:t:0:m1", { ompMessageKey: "entry:t:e1" }))).toBe("entry:t:e1");
  });

  test("a row with no store key in its metadata reports its id", () => {
    expect(storeKeyOf(row("entry:t:e2", {}))).toBe("entry:t:e2");
  });
});
