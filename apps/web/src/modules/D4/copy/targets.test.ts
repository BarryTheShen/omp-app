import { describe, expect, test } from "vitest";
import { realChatEntries } from "./fixtures/real-chat";
import { createCopySourceReader } from "./source";
import { buildCopyTargets } from "./targets";

const TOOL_ONLY_TURN = "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:0c6b5588";

function realChatOptions() {
  return buildCopyTargets(createCopySourceReader()(realChatEntries()));
}

function labelled(label: string) {
  const option = realChatOptions().find((candidate) => candidate.label === label);
  if (option === undefined) throw new Error(`No copy target is labelled "${label}".`);
  return option;
}

describe("buildCopyTargets over the real chat", () => {
  test("offers the newest command and code first, then each message and its parts in order", () => {
    expect(realChatOptions().map((option) => option.label)).toEqual([
      "Latest command",
      "Latest code",
      "Message 1 from you",
      "Code block 1 in message 1",
      "Command 1 in message 1",
      "Message 2",
      "Message 3 from omp",
      "Message 4 from you",
      "Message 5 from omp",
      "Message 6 from you",
      "Command 1 in message 6",
      "Output 1 in message 6",
    ]);
  });

  test("labels are unique, so a chosen label names exactly one shortcut or target", () => {
    const labels = realChatOptions().map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("a fenced block's preview is its code, with the fences removed", () => {
    expect(labelled("Code block 1 in message 1").preview).toBe("const answer = 42;");
    expect(labelled("Command 1 in message 1").preview).toBe("echo inside");
  });

  test("the shortcuts point at the same targets as their listed entries", () => {
    expect(labelled("Latest command").target).toEqual(labelled("Command 1 in message 6").target);
    expect(labelled("Latest code").target).toEqual(labelled("Output 1 in message 6").target);
  });

  test("a message with only reasoning and a tool call is not offered", () => {
    expect(realChatOptions().some((option) => option.target.messageKey === TOOL_ONLY_TURN)).toBe(
      false,
    );
  });

  test("every preview is one non-empty line of at most 140 characters", () => {
    for (const option of realChatOptions()) {
      expect(option.preview.length).toBeGreaterThan(0);
      expect(option.preview.length).toBeLessThanOrEqual(140);
      expect(option.preview).not.toMatch(/\n/);
    }
  });
});
