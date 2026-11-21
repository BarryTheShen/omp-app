import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, test } from "vitest";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import { buildRows, groupToolRuns, type TranscriptRow } from "./rows";

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
  hasOlder: false,
};

function entry(id: string, value: Record<string, unknown>): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: new Date(T).toISOString(),
    ...value,
  } as unknown as SessionEntry;
}

describe("buildRows", () => {
  test("a message keeps its row when the file's copy, under omp's own id, replaces the live one", () => {
    const text = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: T };
    const live = buildRows({ ...idle, entries: [message("live-msg-1", text)] });
    const fromFile = buildRows({ ...idle, entries: [message("a1b2c3d4", text)] });
    expect(live.map((row) => row.key)).toEqual(fromFile.map((row) => row.key));
  });

  test("the model and thinking level a chat starts with are not drawn; a later change is", () => {
    const entries = [
      entry("m0", { type: "model_change", provider: "fake", modelId: "fake-model" }),
      entry("t0", { type: "thinking_level_change", thinkingLevel: "high" }),
      message("u1", { role: "user", content: "hi", timestamp: T }),
      entry("m1", { type: "model_change", provider: "fake", modelId: "other" }),
    ];
    expect(buildRows({ ...idle, entries }).map((row) => row.key)).toEqual(
      buildRows({ ...idle, entries: entries.slice(2) }).map((row) => row.key),
    );
    expect(buildRows({ ...idle, entries }).filter((row) => row.kind === "entry")).toHaveLength(2);
    // A window that does not reach the chat's start may begin with a real change.
    expect(
      buildRows({ ...idle, hasOlder: true, entries: entries.slice(0, 1) }).map((row) => row.kind),
    ).toEqual(["entry"]);
  });

  test("a message omp shows (a background job's notice) gets its row from the live stream; one it hides does not", () => {
    const notice = (display: boolean) =>
      message("live-msg-9", {
        role: "custom",
        customType: "async-result",
        display,
        content:
          "<system-notice>\nBackground job bg_1 has completed.\nquick-done\n</system-notice>",
        details: { jobs: [{ jobId: "bg_1", type: "bash", status: "completed" }] },
        timestamp: T,
      });
    const drawn = (entries: SessionEntry[]) =>
      buildRows({ ...idle, entries }).filter((row) => row.kind === "entry");
    expect(drawn([notice(true)])).toHaveLength(1);
    expect(drawn([notice(false)])).toHaveLength(0);
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

  test("a reply omp stopped itself before it said anything draws no row; one the user stopped still does", () => {
    const stopped = (id: string, errorMessage: string) =>
      message(id, {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage,
        timestamp: T,
      });
    const rows = buildRows({
      ...idle,
      entries: [
        stopped("plan-review", "__omp.silent_abort__"),
        stopped("stop", "Interrupted by user"),
      ],
    });
    expect(rows.map((row) => (row.kind === "entry" ? row.entry.id : row.kind))).toEqual(["stop"]);
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

describe("groupToolRuns", () => {
  const call = (id: string, name = "bash") => ({
    type: "toolCall",
    id,
    name,
    arguments: {},
    intent: `do ${id}`,
  });
  const said = (text: string) => ({ type: "text", text });
  const reply = (id: string, at: number, content: unknown[], extra: Record<string, unknown> = {}) =>
    message(id, { role: "assistant", content, timestamp: T + at, stopReason: "toolUse", ...extra });
  const result = (id: string, callId: string, at: number) =>
    message(id, { role: "toolResult", toolCallId: callId, content: [], timestamp: T + at });
  const shape = (rows: readonly TranscriptRow[]) =>
    rows.map((row) =>
      row.kind === "toolgroup"
        ? `group[${row.items.map((item) => (item.kind === "call" ? item.id : "think")).join(",")}]`
        : row.kind === "entry" && row.entry.type === "message"
          ? `${row.entry.message.role}:${JSON.stringify((row.entry.message as { content: unknown }).content).length}`
          : row.kind,
    );

  test("calls across replies with no text between are one group; the text before them keeps its row and key", () => {
    const entries = [
      message("u1", { role: "user", content: "go", timestamp: T }),
      reply("a1", 1, [said("Checking."), call("c1")]),
      result("r1", "c1", 2),
      reply("a2", 3, [{ type: "thinking", thinking: "hm" }, call("c2", "read")]),
      result("r2", "c2", 4),
      reply("a3", 5, [said("Done.")], { stopReason: "stop" }),
    ];
    const plain = buildRows({ ...idle, entries });
    const rows = groupToolRuns(plain);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "entry", "toolgroup", "entry"]);
    const group = rows[2];
    expect(group?.kind === "toolgroup" ? group.items.map((item) => item.kind) : []).toEqual([
      "call",
      "thinking",
      "call",
    ]);
    // The reply's text is drawn alone under the reply's own key; the last reply is the same row as before.
    expect(rows[1]?.key).toBe(plain[1]?.key);
    const first = rows[1];
    expect(
      first?.kind === "entry" && first.entry.type === "message"
        ? first.entry.message.content
        : null,
    ).toEqual([said("Checking.")]);
    expect(rows[3]).toBe(plain[3]);
  });

  test("one call alone, or calls with text between them, stay as they are", () => {
    const entries = [
      reply("a1", 1, [call("c1")]),
      result("r1", "c1", 2),
      reply("a2", 3, [said("Now the next."), call("c2")]),
      result("r2", "c2", 4),
    ];
    const plain = buildRows({ ...idle, entries });
    expect(groupToolRuns(plain)).toBe(plain);
  });

  test("a group keeps its key when older calls of its run load in front of it", () => {
    const steps = [1, 2, 3, 4].flatMap((n) => [
      reply(`a${n}`, n * 2, [call(`c${n}`)]),
      result(`r${n}`, `c${n}`, n * 2 + 1),
    ]);
    const keys = new Map<string, string>();
    const window = groupToolRuns(
      buildRows({ ...idle, hasOlder: true, entries: steps.slice(4) }),
      keys,
    );
    const whole = groupToolRuns(buildRows({ ...idle, entries: steps }), keys);
    expect(shape(window)).toEqual(["group[c3,c4]"]);
    expect(shape(whole)).toEqual(["group[c1,c2,c3,c4]"]);
    expect(whole[0]?.key).toBe(window[0]?.key);
  });

  test("a group keeps its key while its calls go from running to saved", () => {
    const saved = [reply("a1", 1, [call("c1")]), result("r1", "c1", 2)];
    const live = groupToolRuns(
      buildRows({
        ...idle,
        entries: saved,
        working: true,
        stream: { role: "assistant", content: [call("c2")], timestamp: T + 3 } as never,
        activeTools: new Map([
          ["c3", { toolCallId: "c3", toolName: "read", args: {}, startedAt: T }],
        ]),
      }),
    );
    const done = groupToolRuns(
      buildRows({
        ...idle,
        entries: [
          ...saved,
          reply("a2", 3, [call("c2"), call("c3", "read")]),
          result("r2", "c2", 4),
        ],
      }),
    );
    expect(shape(live)).toEqual(["group[c1,c2,c3]"]);
    expect(shape(done)).toEqual(["group[c1,c2,c3]"]);
    expect(live[0]?.key).toBe(done[0]?.key);
  });

  test("text after the calls in the same reply gets a row of its own after the group", () => {
    const rows = groupToolRuns(
      buildRows({
        ...idle,
        entries: [reply("a1", 1, [said("Before."), call("c1"), call("c2"), said("After.")])],
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual(["entry", "toolgroup", "entry"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    const after = rows[2];
    expect(
      after?.kind === "entry" && after.entry.type === "message"
        ? after.entry.message.content
        : null,
    ).toEqual([said("After.")]);
  });

  test("one-line lead-ins ending in a colon join the calls' group; an answer, a list or one call alone do not", () => {
    const kinds = (rows: readonly TranscriptRow[]) =>
      rows.map((row) =>
        row.kind === "toolgroup"
          ? `group[${row.items.map((item) => item.kind).join(",")}]`
          : row.kind,
      );
    const joined = groupToolRuns(
      buildRows({
        ...idle,
        entries: [
          reply("a1", 1, [said("Checking the queue:"), call("c1")]),
          result("r1", "c1", 2),
          reply("a2", 3, [said("Now the log:"), call("c2")]),
          result("r2", "c2", 4),
        ],
      }),
    );
    expect(kinds(joined)).toEqual(["group[lead,call,lead,call]"]);
    // A finding over more than one line stays in view and ends the run.
    const broken = groupToolRuns(
      buildRows({
        ...idle,
        entries: [
          reply("a1", 1, [call("c1"), call("c2")]),
          reply("a2", 3, [said("Found it:\n- the cache is cold"), call("c3"), call("c4")]),
        ],
      }),
    );
    expect(kinds(broken)).toEqual(["group[call,call]", "entry", "group[call,call]"]);
    // One call: its lead-in stays as written.
    const plain = buildRows({
      ...idle,
      entries: [reply("a1", 1, [said("Checking:"), call("c1")])],
    });
    expect(groupToolRuns(plain)).toBe(plain);
  });

  test("a lead-in still being written joins only once a call follows it", () => {
    const saved = [reply("a1", 1, [call("c1"), call("c2")]), result("r1", "c2", 2)];
    const writing = (content: unknown[]) =>
      groupToolRuns(
        buildRows({
          ...idle,
          entries: saved,
          working: true,
          stream: { role: "assistant", content, timestamp: T + 3 } as never,
        }),
      ).map((row) => row.kind);
    // "Results:" may go on to a list: drawn as text while it is the last block.
    expect(writing([said("Results:")])).toEqual(["toolgroup", "stream"]);
    expect(writing([said("Results:"), call("c3")])).toEqual(["toolgroup"]);
  });

  test("a reply that failed stays whole, its calls with it", () => {
    const entries = [
      reply("a1", 1, [call("c1")]),
      result("r1", "c1", 2),
      reply("a2", 3, [call("c2")], { stopReason: "error", errorMessage: "overloaded" }),
    ];
    expect(shape(groupToolRuns(buildRows({ ...idle, entries })))).toEqual([
      expect.stringMatching(/^assistant:/),
      expect.stringMatching(/^assistant:/),
      "failure",
    ]);
  });
});
