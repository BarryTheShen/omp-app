import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { switcherChats } from "./switcher";

/** A folder's chats, newest first: "chat 1" is the newest. */
const chats = Array.from({ length: 80 }, (_, index) => {
  const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as ThreadId;
  return {
    id,
    title: index === 39 ? "Budget for the trip to Lisbon" : `chat ${index + 1}`,
    target: { kind: "existing" as const, threadId: id, sessionFile: null },
  };
});

describe("the lite view's chat switcher", () => {
  test("without a search it offers the 12 newest chats", () => {
    expect(switcherChats(chats, "  ").map((chat) => chat.title)).toEqual(
      Array.from({ length: 12 }, (_, index) => `chat ${index + 1}`),
    );
  });

  test("a search finds a chat beyond the newest, by any part of its title, whatever its case", () => {
    expect(switcherChats(chats, "  LISBON ").map((chat) => chat.title)).toEqual([
      "Budget for the trip to Lisbon",
    ]);
    expect(switcherChats(chats, "no such words")).toEqual([]);
  });

  test("a search that fits many lists the 50 newest of them", () => {
    const found = switcherChats(chats, "chat");
    expect(found).toHaveLength(50);
    expect(found[0]?.title).toBe("chat 1");
  });
});
