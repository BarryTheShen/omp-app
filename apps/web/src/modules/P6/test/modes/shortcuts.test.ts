import { describe, expect, test } from "vitest";
import { P6_SHORTCUT_DESCRIPTORS } from "../../shortcuts";

describe("P6 shortcut descriptors", () => {
  test("claims only the two researched queue keybindings", () => {
    expect(P6_SHORTCUT_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: "P6.message.followUp",
        chord: "Mod+Enter",
        covers: ["P5.follow-up-on-ctrl-enter-ctrl-q", "P5.app-message-followup"],
      }),
      expect.objectContaining({
        id: "P6.message.dequeue",
        chord: "Alt+ArrowUp",
        covers: ["P5.dequeue-queued-message", "P5.app-message-dequeue"],
      }),
    ]);
  });
});
