import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, test } from "vitest";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import { buildRows } from "./rows";

const T = 1_790_000_000_000;

function message(id: string, value: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(T).toISOString(),
    message: value,
  } as unknown as SessionEntry;
}

const idle = {
  stream: null,
  streamDone: false,
  activeTools: new Map<string, ActiveTool>(),
  working: false,
};

describe("buildRows", () => {
  test("a message keeps its row when the file's copy, under omp's own id, replaces the live one", () => {
    const text = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: T };
    const live = buildRows({ ...idle, entries: [message("live-msg-1", text)] });
    const fromFile = buildRows({ ...idle, entries: [message("a1b2c3d4", text)] });
    expect(live.map((row) => row.key)).toEqual(fromFile.map((row) => row.key));
  });

  test("tool results show inside their call's card, not as rows of their own", () => {
    const rows = buildRows({
      ...idle,
      entries: [
        message("u", { role: "user", content: "list files", timestamp: T }),
        message("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
          timestamp: T + 1,
        }),
        message("r", {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [],
          timestamp: T + 2,
        }),
      ],
    });
    expect(rows.map((row) => (row.kind === "entry" ? row.entry.id : row.kind))).toEqual(["u", "a"]);
  });

  test("a running tool that no message holds yet gets a row; one already in a message does not", () => {
    const tool = (toolCallId: string): ActiveTool => ({
      toolCallId,
      toolName: "bash",
      args: {},
      startedAt: T,
    });
    const rows = buildRows({
      ...idle,
      working: true,
      activeTools: new Map([
        ["call-1", tool("call-1")],
        ["call-2", tool("call-2")],
      ]),
      entries: [
        message("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
          timestamp: T,
        }),
      ],
    });
    const tools = rows.find((row) => row.kind === "tools");
    expect(tools?.kind === "tools" ? tools.tools.map((item) => item.toolCallId) : []).toEqual([
      "call-2",
    ]);
  });

  test("while omp works with nothing to show yet, the last row says it is thinking", () => {
    const rows = buildRows({ ...idle, working: true, entries: [] });
    expect(rows.map((row) => row.kind)).toEqual(["working"]);
  });
});
