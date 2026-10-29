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
  shell: null,
  notices: [],
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

  test("a failed request is one failure row; only the chat's last one can be retried", () => {
    const failed = (id: string, at: number, error: string) =>
      message(id, {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: error,
        timestamp: at,
      });
    const entries = [
      message("u1", { role: "user", content: "first", timestamp: T }),
      failed("a1", T + 1, "401 Invalid API key"),
      message("u2", { role: "user", content: "second", timestamp: T + 2 }),
      failed("a2", T + 3, "503 Overloaded"),
    ];
    const rows = buildRows({ ...idle, entries });
    expect(
      rows.map((row) =>
        row.kind === "failure"
          ? `failure ${row.error} ${row.latest}`
          : row.kind === "entry"
            ? row.entry.id
            : row.kind,
      ),
    ).toEqual(["u1", "failure 401 Invalid API key false", "u2", "failure 503 Overloaded true"]);

    // While omp works again (a retry), the failure is no longer the last word.
    const retrying = buildRows({ ...idle, working: true, entries });
    expect(retrying.some((row) => row.kind === "failure" && row.latest)).toBe(false);
  });

  test("a reply that failed after it had begun keeps what it said, then shows the failure", () => {
    const rows = buildRows({
      ...idle,
      entries: [
        message("a", {
          role: "assistant",
          content: [{ type: "text", text: "A partial answer." }],
          stopReason: "error",
          errorMessage: "",
          timestamp: T,
        }),
      ],
    });
    expect(rows.map((row) => (row.kind === "failure" ? `failure ${row.error}` : row.kind))).toEqual(
      ["entry", "failure The request failed."],
    );
  });

  test("a saved `!` run is a run box with its command, output and exit; a run in progress follows the rest", () => {
    const rows = buildRows({
      ...idle,
      shell: { method: "python", input: "print(2)", startedAt: T, excludeFromContext: false },
      notices: [{ id: 1, text: "Session: 12 messages", level: "output" }],
      entries: [
        message("b", {
          role: "bashExecution",
          command: "ls",
          output: "a.ts\n",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: true,
          timestamp: T,
        }),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual(["shell", "shell", "notice"]);
    const [saved, live] = rows;
    expect(saved?.kind === "shell" ? saved.run : null).toMatchObject({
      method: "bash",
      input: "ls",
      output: "a.ts\n",
      exitCode: 0,
      excludeFromContext: true,
      running: false,
    });
    expect(live?.kind === "shell" ? live.run : null).toMatchObject({
      method: "python",
      input: "print(2)",
      running: true,
    });
  });
});
