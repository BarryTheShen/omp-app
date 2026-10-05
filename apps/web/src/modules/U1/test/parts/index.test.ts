import { describe, expect, test } from "vitest";
import * as parts from "../../parts";
import * as slots from "../../tool-slots";

describe("U1.3 public barrels", () => {
  test("export the message-part and tool-boundary contracts", () => {
    expect(parts.MessageParts).toBeTypeOf("function");
    expect(parts.ImagePart).toBeTypeOf("function");
    expect(slots.ToolSlot).toBeTypeOf("function");
  });
});
