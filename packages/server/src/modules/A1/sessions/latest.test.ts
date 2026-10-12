import { describe, expect, test } from "bun:test";
import { newestContinuableChat } from "./latest";

function chat(
  id: string,
  fields: {
    readonly assistantTurns: number;
    readonly title?: string | null;
    readonly firstPrompt?: string | null;
    readonly status?: string;
  },
) {
  return { id, ...fields };
}

describe("newestContinuableChat, omp's --continue rule", () => {
  test("passes over a newest chat with no assistant turn, no name and no first message", () => {
    const sessions = [
      chat("empty", { assistantTurns: 0, title: null, firstPrompt: null }),
      chat("used", { assistantTurns: 3 }),
    ];
    expect(newestContinuableChat(sessions)?.id).toBe("used");
  });

  test("keeps a newest chat that has a first message but no name, even with no assistant turn", () => {
    const sessions = [
      chat("asked", { assistantTurns: 0, title: null, firstPrompt: "Plan the release" }),
      chat("used", { assistantTurns: 3 }),
    ];
    expect(newestContinuableChat(sessions)?.id).toBe("asked");
  });

  test("keeps a newest chat that has a name but no first message", () => {
    const sessions = [chat("named", { assistantTurns: 0, title: "Plan", firstPrompt: null })];
    expect(newestContinuableChat(sessions)?.id).toBe("named");
  });

  test("passes over a newest chat whose first message is the no-messages label", () => {
    const sessions = [
      chat("labelled", { assistantTurns: 0, title: null, firstPrompt: "(no messages)" }),
      chat("used", { assistantTurns: 3 }),
    ];
    expect(newestContinuableChat(sessions)?.id).toBe("used");
  });

  test("keeps a newest chat whose status is settled, even with no assistant turn", () => {
    const sessions = [chat("settled", { assistantTurns: 0, status: "complete" })];
    expect(newestContinuableChat(sessions)?.id).toBe("settled");
  });

  test("a folder with only empty chats has none to continue", () => {
    const sessions = [chat("blank", { assistantTurns: 0, title: "   ", firstPrompt: "  " })];
    expect(newestContinuableChat(sessions)).toBeUndefined();
  });
});
