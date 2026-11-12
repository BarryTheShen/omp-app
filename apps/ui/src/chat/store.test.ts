import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatSessionEvent } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildRows, toolResults } from "./rows";
import { applyDelta, ChatStore } from "./store";

const T = 1_790_000_000_000;

function assistant(content: AssistantMessage["content"], timestamp = T): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AssistantMessage;
}

/** One chat-host event as the server delivers it. */
function event(value: Record<string, unknown>): ChatSessionEvent {
  return { kind: "event", event: value } as unknown as ChatSessionEvent;
}

function fileEntry(id: string, message: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(T).toISOString(),
    message,
  } as unknown as SessionEntry;
}

describe("ChatStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a reply streamed as deltas shows its text at the next frame, and its end commits it as an entry", () => {
    const store = new ChatStore();
    store.apply(event({ type: "message_start", messageId: "msg-1", message: assistant([]) }));
    store.apply(
      event({
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      }),
    );
    store.apply(
      event({
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
      }),
    );
    store.apply(
      event({
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " there" },
      }),
    );
    // Streaming updates wait for the frame.
    expect(store.getSnapshot().stream?.content).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(store.getSnapshot().stream?.content).toEqual([{ type: "text", text: "Hello there" }]);

    const final = assistant([{ type: "text", text: "Hello there." }]);
    store.apply(event({ type: "message_end", messageId: "msg-1", message: final }));
    const snapshot = store.getSnapshot();
    expect(snapshot.stream).toBeNull();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ type: "message", message: final });
  });

  test("a change that is not streaming is shown at once, together with the streaming update still waiting", () => {
    const store = new ChatStore();
    store.apply(event({ type: "message_start", messageId: "msg-1", message: assistant([]) }));
    store.apply(
      event({
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      }),
    );
    store.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      }),
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.stream?.content).toEqual([{ type: "text", text: "" }]);
    expect([...snapshot.activeTools.keys()]).toEqual(["call-1"]);
  });

  test("events the server replays at the open are drawn together at the next frame; a live one at once", () => {
    const store = new ChatStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T };
    store.apply(event({ type: "agent_start" }), true);
    store.apply(event({ type: "message_end", messageId: "msg-1", message: user }), true);
    store.apply(event({ type: "agent_end", messages: [] }), true);
    expect(heard).toBe(0);
    vi.advanceTimersToNextFrame();
    expect(heard).toBe(1);
    expect(store.getSnapshot().entries).toHaveLength(1);
    expect(store.getSnapshot().working).toBe(false);

    store.apply(event({ type: "agent_start" }));
    expect(heard).toBe(2);
    expect(store.getSnapshot().working).toBe(true);
  });

  test("a message the file already holds is not added again when the live stream ends it", () => {
    const store = new ChatStore();
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T };
    store.setWindow([fileEntry("u1", user)], false);
    store.apply(event({ type: "message_end", messageId: "msg-1", message: user }));
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["u1"]);
  });

  test("a message that starts a turn shows at once and the chat works; omp's copy takes its place (#2828)", () => {
    const store = new ChatStore();
    store.sendStarted("hi", []);
    const shown = store.getSnapshot();
    expect(shown.working).toBe(true);
    expect(shown.entries.map((entry) => (entry as { message?: unknown }).message)).toMatchObject([
      { role: "user", content: "hi" },
    ]);

    // omp starts the turn seconds later and sends the message back: one message, omp's.
    store.apply(event({ type: "agent_start" }));
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T };
    store.apply(event({ type: "message_end", messageId: "msg-1", message: user }));
    const entries = store.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: user });
  });

  test("a message whose prompt never reached the model leaves the chat, and the chat stops working (#2828)", () => {
    const store = new ChatStore();
    store.sendStarted("hi", []);
    store.apply(
      event({
        type: "prompt_result",
        requestId: "r1",
        agentInvoked: false,
        status: "error",
        sessionSettled: true,
      }),
    );
    expect(store.getSnapshot().entries).toEqual([]);
    expect(store.getSnapshot().working).toBe(false);
  });

  test("Stop before omp started the turn: the chat stops working and the message goes back to the box (#2828)", () => {
    const store = new ChatStore();
    const back: unknown[] = [];
    store.onSendDropped((sent) => back.push(sent));
    const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;
    store.sendStarted("hi", [image]);
    // omp dropped the message: no run, and a result that says the prompt was aborted.
    store.apply(
      event({
        type: "prompt_result",
        requestId: "r1",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      }),
    );
    expect(store.getSnapshot().entries).toEqual([]);
    expect(store.getSnapshot().working).toBe(false);
    expect(back).toEqual([{ text: "hi", images: [image] }]);
  });

  test("Stop during the turn leaves the message in the chat, not in the box", () => {
    const store = new ChatStore();
    const back: unknown[] = [];
    store.onSendDropped((sent) => back.push(sent));
    store.sendStarted("hi", []);
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T };
    store.apply(event({ type: "agent_start" }));
    store.apply(event({ type: "message_end", messageId: "msg-1", message: user }));
    store.apply(event({ type: "agent_end", messages: [] }));
    store.apply(
      event({
        type: "prompt_result",
        requestId: "r1",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      }),
    );
    expect(store.getSnapshot().entries).toHaveLength(1);
    expect(store.getSnapshot().working).toBe(false);
    expect(back).toEqual([]);
  });

  test("a running tool shows until its end, and every tool stops showing when omp's turn ends", () => {
    const store = new ChatStore();
    store.apply(event({ type: "agent_start" }));
    store.apply(
      event({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }),
    );
    store.apply(
      event({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: {} }),
    );
    store.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "a",
        toolName: "bash",
        result: {},
        isError: false,
      }),
    );
    expect([...store.getSnapshot().activeTools.keys()]).toEqual(["b"]);
    expect(store.getSnapshot().working).toBe(true);
    store.apply(event({ type: "agent_end", messages: [] }));
    expect(store.getSnapshot().activeTools.size).toBe(0);
    expect(store.getSnapshot().working).toBe(false);
  });

  test("a retried tool batch drops its stopped result and the stop after it, so the call shows as running again", () => {
    const store = new ChatStore();
    const earlier = {
      role: "toolResult",
      toolCallId: "c0",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: T - 2,
    };
    const user = { role: "user", content: [{ type: "text", text: "go" }], timestamp: T - 1 };
    const calls = {
      ...assistant([
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 30" } },
      ]),
      stopReason: "toolUse",
    };
    const stopped = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "aborted" }],
      isError: true,
      timestamp: T + 1,
    };
    const stop = {
      ...assistant([], T + 2),
      stopReason: "aborted",
      errorMessage: "Interrupted by user",
    };
    store.setWindow(
      [
        fileEntry("r0", earlier),
        fileEntry("u1", user),
        fileEntry("a1", calls),
        fileEntry("r1", stopped),
        fileEntry("x1", stop),
      ],
      false,
    );
    const ids = () => store.getSnapshot().entries.map((entry) => entry.id);

    store.apply(event({ type: "agent_start" }));
    expect(ids()).toEqual(["r0", "u1", "a1", "r1", "x1"]);

    store.apply(event({ type: "agent_start", resumedToolCallIds: ["c1"] }));
    expect(ids()).toEqual(["r0", "u1", "a1"]);
    store.apply(
      event({
        type: "message_end",
        messageId: "r2",
        message: {
          ...stopped,
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: T + 9,
        },
      }),
    );
    expect(toolResults(store.getSnapshot().entries).get("c1")?.isError).toBe(false);
  });

  test("a command left running in the background reports on its call's card, never as a call still running (#2800)", () => {
    const store = new ChatStore();
    const calls = {
      ...assistant([
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "sleep 600", async: true },
        },
      ]),
      stopReason: "toolUse",
    };
    const backgrounded = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "Backgrounded as job bg_1" }],
      isError: false,
      timestamp: T + 1,
    };
    store.setWindow([fileEntry("a1", calls), fileEntry("r1", backgrounded)], false);
    store.apply(event({ type: "agent_start" }));
    const frame = (state: string, text: string) => ({
      content: [{ type: "text", text }],
      details: { async: { state, jobId: "bg_1", type: "bash" } },
    });
    // The job goes on long after its call returned: each report is the card's, not a running call's.
    for (const [state, text] of [
      ["running", "half way"],
      ["completed", "all done"],
    ] as const) {
      store.apply(
        event({
          type: "tool_execution_update",
          toolCallId: "c1",
          toolName: "bash",
          args: {},
          partialResult: frame(state, text),
        }),
      );
      // Updates publish once a frame.
      vi.advanceTimersToNextFrame();
      const snapshot = store.getSnapshot();
      expect(snapshot.activeTools.size).toBe(0);
      expect(toolResults(snapshot.entries, snapshot.jobs).get("c1")).toMatchObject({
        content: [{ type: "text", text }],
        details: { async: { state } },
      });
    }
    // Long after, the call's message has left the chat's window of entries (a long chat): nothing shows as a call still
    // running at the chat's end, where a report used to bring the call back as one.
    expect(
      buildRows({ ...store.getSnapshot(), entries: [] }).some((row) => row.kind === "tools"),
    ).toBe(false);
  });

  test("older entries go in front without repeating the ones already shown", () => {
    const store = new ChatStore();
    store.setWindow([fileEntry("e3", { role: "user", content: "c", timestamp: T + 3 })], true);
    store.prependWindow(
      [
        fileEntry("e1", { role: "user", content: "a", timestamp: T + 1 }),
        fileEntry("e2", { role: "user", content: "b", timestamp: T + 2 }),
        fileEntry("e3", { role: "user", content: "c", timestamp: T + 3 }),
      ],
      false,
    );
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["e1", "e2", "e3"]);
    expect(store.getSnapshot().hasOlder).toBe(false);
  });

  test("the read of an older window shows while under way and ends with its entries in front", () => {
    const store = new ChatStore();
    store.setWindow([fileEntry("e3", { role: "user", content: "c", timestamp: T + 3 })], true);
    store.setOlderLoad("loading");
    expect(store.getSnapshot().olderLoad).toBe("loading");
    store.prependWindow([fileEntry("e2", { role: "user", content: "b", timestamp: T + 2 })], true);
    // The transcript's top says Loading earlier messages no more, and reads the next window when the reader is near.
    expect(store.getSnapshot().olderLoad).toBe("idle");
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["e2", "e3"]);
  });

  test("an older window that failed to read may be read again once the chat's window is read again", () => {
    const store = new ChatStore();
    store.setWindow([fileEntry("e3", { role: "user", content: "c", timestamp: T + 3 })], true);
    store.setOlderLoad("failed");
    expect(store.getSnapshot().olderLoad).toBe("failed");
    // The link came back and the chat's newest window was read over it (a resync).
    store.setWindow([fileEntry("e3", { role: "user", content: "c", timestamp: T + 3 })], true);
    expect(store.getSnapshot().olderLoad).toBe("idle");
  });

  test("a window read again keeps the older entries shown in front of it, and a branch's keeps its ancestors (#2768)", () => {
    const store = new ChatStore();
    const message = (n: number) =>
      fileEntry(`e${n}`, { role: "user", content: `m${n}`, timestamp: T + n });
    const ids = () => store.getSnapshot().entries.map((entry) => entry.id);
    store.setWindow([message(3), message(4)], true);
    store.prependWindow([message(1), message(2)], false);
    // A turn ended: the newest window is read again, one entry further on. What the reader loaded above stays.
    store.setWindow([message(4), message(5)], true);
    expect(ids()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(store.getSnapshot().hasOlder).toBe(false);
    // Edit went back to e3: its branch's window ends there, with e1 and e2 still in front.
    store.setWindow([message(2), message(3)], true);
    expect(ids()).toEqual(["e1", "e2", "e3"]);
    // Another file's window shares no entry: it replaces what was shown.
    store.setWindow([fileEntry("x1", { role: "user", content: "x", timestamp: T + 9 })], true);
    expect(ids()).toEqual(["x1"]);
    expect(store.getSnapshot().hasOlder).toBe(true);
  });

  test("a message replayed from before the file's window is left to the older windows; one after it is added (#2768)", () => {
    const store = new ChatStore();
    store.setWindow([fileEntry("e5", { role: "user", content: "m5", timestamp: T + 5 })], true);
    store.apply(
      event({
        type: "message_end",
        messageId: "old",
        message: { role: "user", content: "m1", timestamp: T + 1 },
      }),
    );
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["e5"]);
    expect(store.beyondWindow).toBe(false);
    store.apply(
      event({
        type: "message_end",
        messageId: "new",
        message: { role: "user", content: "m6", timestamp: T + 6 },
      }),
    );
    expect(store.getSnapshot().entries).toHaveLength(2);
    expect(store.beyondWindow).toBe(true);
  });

  test("the queue shows only messages that can still be taken back: steers already sent into the reply drop out", () => {
    const store = new ChatStore();
    store.apply(
      event({
        type: "queue_update",
        steering: ["already sent", "check the tests too"],
        followUp: ["then write the docs"],
        liveSteered: 1,
      }),
    );
    expect(store.getSnapshot().queue).toEqual({
      steering: ["check the tests too"],
      followUp: ["then write the docs"],
    });
    store.apply(event({ type: "queue_update", steering: [], followUp: [], liveSteered: 0 }));
    expect(store.getSnapshot().queue).toEqual({ steering: [], followUp: [] });
  });

  test("the thinking level shows the level chosen, not the one `auto` resolved to", () => {
    const store = new ChatStore();
    store.apply(event({ type: "thinking_level_changed", thinkingLevel: "high" }));
    expect(store.getSnapshot().thinkingLevel).toBe("high");
    store.apply(
      event({ type: "thinking_level_changed", thinkingLevel: "medium", configured: "auto" }),
    );
    expect(store.getSnapshot().thinkingLevel).toBe("auto");
  });

  test("the working row names the most specific step: compaction, a retry, a tool's intent, thinking, writing", () => {
    const store = new ChatStore();
    const label = () => store.getSnapshot().activity?.label;
    expect(store.getSnapshot().activity).toBeNull();
    store.apply(event({ type: "agent_start" }));
    expect(label()).toBe("Working");
    const since = store.getSnapshot().activity?.since;

    store.apply(event({ type: "message_start", messageId: "m", message: assistant([]) }));
    store.apply(
      event({
        type: "message_update",
        messageId: "m",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      }),
    );
    vi.runAllTimers();
    expect(label()).toBe("Thinking");

    store.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: {},
        intent: "Reading the parser",
      }),
    );
    expect(label()).toBe("Reading the parser");
    store.apply(
      event({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: {} }),
    );
    expect(label()).toBe("Running bash");

    store.apply(
      event({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 50,
        errorMessage: "x",
      }),
    );
    expect(label()).toBe("Retrying, attempt 2 of 3");
    store.apply(
      event({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }),
    );
    expect(label()).toBe("Compacting the chat");
    // The time counts from the start of the turn, whatever the step.
    expect(store.getSnapshot().activity?.since).toBe(since);

    store.apply(
      event({
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: false,
      }),
    );
    store.apply(event({ type: "agent_end", messages: [] }));
    expect(store.getSnapshot().activity).toBeNull();
  });

  test("a command's output and omp's errors stay as notices until dismissed; its status lines pass as toasts", () => {
    const store = new ChatStore();
    store.apply(event({ type: "command_output", text: "Active tools: bash, read" }));
    store.apply(
      event({
        type: "notice",
        level: "error",
        message: "disk full",
        source: "session-persistence",
      }),
    );
    store.apply(event({ type: "ui_notify", message: "No open PRs", notifyType: "warning" }));
    expect(store.getSnapshot().notices.map(({ text, level }) => `${level}: ${text}`)).toEqual([
      "output: Active tools: bash, read",
      "error: session-persistence: disk full",
    ]);
    expect(store.getSnapshot().toast).toMatchObject({ text: "No open PRs", tone: "warning" });

    const [first] = store.getSnapshot().notices;
    if (first !== undefined) store.dismissNotice(first.id);
    expect(store.getSnapshot().notices.map((notice) => notice.text)).toEqual([
      "session-persistence: disk full",
    ]);
  });

  test("a status line too long for a toast, or on several lines, is a dim row; a long warning or error is a notice", () => {
    const store = new ChatStore();
    const tools = Array.from({ length: 40 }, (_, index) => `mcp__notion_tool_${index}`).join(", ");
    store.apply(
      event({ type: "notice", level: "info", message: `mounted ${tools}`, source: "xdev" }),
    );
    store.apply(event({ type: "notice", level: "warning", message: "first line\nsecond line" }));
    store.toast(`New window: ${"refused ".repeat(30)}`, "error");
    expect(store.getSnapshot().toast).toBeNull();
    expect(store.getSnapshot().notices.map((notice) => notice.level)).toEqual([
      "status",
      "warning",
      "error",
    ]);
    expect(store.getSnapshot().notices[0]?.text).toBe(`xdev: mounted ${tools}`);

    store.apply(event({ type: "ui_notify", message: "Reloaded" }));
    expect(store.getSnapshot().toast).toMatchObject({ text: "Reloaded", tone: "info" });
    expect(store.getSnapshot().notices).toHaveLength(3);
  });

  test("one toast at a time: a newer one takes its place, and only its own time ends it", () => {
    const store = new ChatStore();
    store.apply(event({ type: "ui_notify", message: "Reloaded" }));
    const first = store.getSnapshot().toast;
    store.apply(event({ type: "notice", level: "info", message: "Saved", source: "btw-history" }));
    const second = store.getSnapshot().toast;
    expect(second).toMatchObject({ text: "btw-history: Saved", tone: "info" });

    // The replaced toast's timer ends nothing; the shown one's does.
    if (first !== null) store.dismissToast(first.id);
    expect(store.getSnapshot().toast).toBe(second);
    if (second !== null) store.dismissToast(second.id);
    expect(store.getSnapshot().toast).toBeNull();

    // A toast after a dismissal gets a new id, so an old timer cannot end it.
    store.toast("Only one role model available", "info");
    const third = store.getSnapshot().toast;
    expect(third?.id).not.toBe(first?.id);
    if (first !== null) store.dismissToast(first.id);
    expect(store.getSnapshot().toast).toBe(third);
  });

  test("omp's roster and its subagent events make one row per agent, in spawn order, with the latest progress", () => {
    const store = new ChatStore();
    const progress = (id: string, status: string, tokens: number) => ({
      index: 0,
      id,
      agent: "task",
      agentSource: "bundled",
      status,
      task: "t",
      recentTools: [],
      recentOutput: [],
      toolCount: 1,
      requests: 1,
      tokens,
      cost: 0,
      durationMs: 10,
    });
    store.setAgents([
      {
        id: "Second",
        index: 1,
        agent: "task",
        agentSource: "bundled",
        status: "running",
        lastUpdate: 1,
      },
    ] as never);
    store.apply(
      event({
        type: "subagent_lifecycle",
        payload: {
          id: "First",
          index: 0,
          agent: "task",
          agentSource: "bundled",
          status: "started",
        },
      }),
    );
    store.apply(
      event({
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "task",
          agentSource: "bundled",
          task: "t",
          sessionFile: "/s/First.jsonl",
          progress: progress("First", "running", 15),
        },
      }),
    );
    // Progress waits for the frame, as streaming does.
    vi.advanceTimersToNextFrame();
    expect(store.getSnapshot().agents.map((agent) => `${agent.id} ${agent.status}`)).toEqual([
      "First running",
      "Second running",
    ]);
    expect(store.getSnapshot().agents[0]?.progress?.tokens).toBe(15);

    store.apply(
      event({
        type: "subagent_lifecycle",
        payload: {
          id: "First",
          index: 0,
          agent: "task",
          agentSource: "bundled",
          status: "aborted",
        },
      }),
    );
    vi.advanceTimersToNextFrame();
    const [first] = store.getSnapshot().agents;
    // The end keeps what the run reported last, and the file it wrote.
    expect(first).toMatchObject({ status: "aborted", sessionFile: "/s/First.jsonl" });
    expect(first?.progress?.tokens).toBe(15);
  });

  test("the todo list is the state's at first, then what each todo result says; a failed todo call leaves it", () => {
    const store = new ChatStore();
    const board = (status: string) => [
      {
        name: "Plan",
        tasks: [
          { content: "Write the thing", status },
          { content: "Test the thing", status: "pending" },
        ],
      },
    ];
    store.setState(
      { queuedMessages: { steering: [], followUp: [] }, todoPhases: board("pending") } as never,
      store.activityMark,
    );
    expect(store.getSnapshot().todos[0]?.tasks[0]?.status).toBe("pending");

    const end = (toolName: string, phases: unknown, isError = false) =>
      event({
        type: "tool_execution_end",
        toolCallId: `call-${toolName}-${String(isError)}`,
        toolName,
        isError,
        result: { content: [], details: { phases } },
      });
    store.apply(end("todo", board("completed")));
    expect(store.getSnapshot().todos[0]?.tasks[0]?.status).toBe("completed");
    store.apply(end("todo", board("abandoned"), true));
    store.apply(end("bash", board("abandoned")));
    expect(store.getSnapshot().todos[0]?.tasks[0]?.status).toBe("completed");
    // A state read without a todo list leaves the one shown.
    store.setState({ queuedMessages: { steering: [], followUp: [] } } as never, store.activityMark);
    expect(store.getSnapshot().todos).toHaveLength(1);
  });

  test("a state read says whether omp works and compacts, unless a turn or a compaction started or ended after it was asked", () => {
    const store = new ChatStore();
    const read = (isStreaming: boolean, isCompacting = false) =>
      ({ queuedMessages: { steering: [], followUp: [] }, isStreaming, isCompacting }) as never;
    // Opened in the middle of a turn, or its start lost in a reconnect: the read shows omp working.
    store.setState(read(true), store.activityMark);
    expect(store.getSnapshot().working).toBe(true);
    expect(store.getSnapshot().activity).not.toBeNull();
    // A read asked before the turn ended that answers after the end is older than the end: it changes nothing.
    const asked = store.activityMark;
    store.apply(event({ type: "agent_end", messages: [] }));
    store.setState(read(true), asked);
    expect(store.getSnapshot().working).toBe(false);
    // A turn whose end was lost: the read ends it.
    store.apply(event({ type: "agent_start" }));
    store.setState(read(false), store.activityMark);
    expect(store.getSnapshot().working).toBe(false);
    expect(store.getSnapshot().activity).toBeNull();
    // A compaction whose end was lost ends with a read too.
    store.setState(read(false, true), store.activityMark);
    expect(store.getSnapshot().activity).not.toBeNull();
    store.setState(read(false), store.activityMark);
    expect(store.getSnapshot().activity).toBeNull();
  });

  test("a turn found running when omp refused a prompt as busy outlasts a read asked before it was found", () => {
    const store = new ChatStore();
    const asked = store.activityMark;
    store.markWorking();
    store.setState(
      { queuedMessages: { steering: [], followUp: [] }, isStreaming: false } as never,
      asked,
    );
    expect(store.getSnapshot().working).toBe(true);
  });

  test("a read asked before a replay that holds a compaction, not the turn's start, still says omp works (#2768)", () => {
    const store = new ChatStore();
    const read = (isStreaming: boolean, isCompacting: boolean) =>
      ({ queuedMessages: { steering: [], followUp: [] }, isStreaming, isCompacting }) as never;
    // Opened in the middle of a long turn: the state is asked with the subscription, and the replay that comes first
    // holds a compaction but not the turn's start.
    const asked = store.activityMark;
    store.apply(
      event({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }),
    );
    store.apply(
      event({
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: false,
      }),
    );
    store.setState(read(true, true), asked);
    expect(store.getSnapshot().working).toBe(true);
    // The compaction's end came after the read was asked: the compaction is over.
    expect(store.getSnapshot().activity?.label).not.toBe("Compacting the chat");
    // A turn's end in the replay still outranks a read asked before it.
    const later = store.activityMark;
    store.apply(event({ type: "agent_end", messages: [] }));
    store.setState(read(true, false), later);
    expect(store.getSnapshot().working).toBe(false);
  });

  test("omp's answer to a write of xd://propose waits for review under the model's name; a failed write or another file does not", () => {
    const store = new ChatStore();
    const write = (id: string, path: string, details: unknown, isError = false) => {
      store.apply(
        event({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "write",
          args: { path, content: "fix-the-login" },
        }),
      );
      store.apply(
        event({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "write",
          isError,
          result: { content: [], details },
        }),
      );
    };
    const proposed = {
      xdev: { tool: "propose", inner: { planFilePath: "local://fix-the-login-plan.md" } },
    };
    write("plain", "notes.md", {});
    write("refused", "xd://propose", proposed, true);
    expect(store.getSnapshot().proposal).toBeNull();

    write("proposal", "xd://propose", proposed);
    expect(store.getSnapshot().proposal).toEqual({
      planFilePath: "local://fix-the-login-plan.md",
      title: "fix-the-login",
    });
    store.clearProposal();
    expect(store.getSnapshot().proposal).toBeNull();

    const goal = {
      id: "g",
      objective: "Ship",
      status: "paused",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    store.apply(event({ type: "goal_updated", goal }));
    expect(store.getSnapshot().goal?.status).toBe("paused");
    store.apply(event({ type: "goal_updated", goal: null }));
    expect(store.getSnapshot().goal).toBeNull();
  });

  test("a plan in the chat's file that the person has not answered waits for review when the file is read; one answered by a message, or set aside here, does not come back", () => {
    const call = (id: string) => ({
      ...assistant([
        {
          type: "toolCall",
          id,
          name: "write",
          arguments: { path: "xd://propose", content: "fix-the-login" },
        },
      ]),
      stopReason: "toolUse",
    });
    const answer = (id: string, isError = false) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "write",
      content: [{ type: "text", text: "Plan submitted for review." }],
      details: {
        xdev: { tool: "propose", inner: { planFilePath: "local://fix-the-login-plan.md" } },
      },
      isError,
      timestamp: T + 1,
    });
    const proposed = [fileEntry("a1", call("p1")), fileEntry("r1", answer("p1"))];
    const plan = { planFilePath: "local://fix-the-login-plan.md", title: "fix-the-login" };

    // A page opened after the server restarted: no event of the plan, only the file.
    const opened = new ChatStore();
    opened.setWindow(proposed, false);
    expect(opened.getSnapshot().proposal).toEqual(plan);
    // Set aside here (Keep planning), a window read again after a turn does not bring it back.
    opened.clearProposal();
    opened.setWindow(proposed, false);
    expect(opened.getSnapshot().proposal).toBeNull();

    // The person wrote after it: answered.
    const answered = new ChatStore();
    answered.setWindow(
      [...proposed, fileEntry("u1", { role: "user", content: "Plan more", timestamp: T + 2 })],
      false,
    );
    expect(answered.getSnapshot().proposal).toBeNull();

    // omp refused the write: nothing to review.
    const refused = new ChatStore();
    refused.setWindow([fileEntry("a2", call("p2")), fileEntry("r2", answer("p2", true))], false);
    expect(refused.getSnapshot().proposal).toBeNull();
  });

  test("a sign-in's page to open is kept until the sign-in ends, without omp's local link; the latest page wins", () => {
    const store = new ChatStore();
    store.apply(event({ type: "ui_open_url", url: "https://example.test/auth?state=1" }));
    expect(store.getSnapshot().signIn).toEqual({ url: "https://example.test/auth?state=1" });
    store.apply(
      event({
        type: "ui_open_url",
        url: "https://example.test/auth?state=2",
        launchUrl: "http://127.0.0.1:1455/start",
        instructions: "Paste the code it shows.",
      }),
    );
    expect(store.getSnapshot().signIn).toEqual({
      url: "https://example.test/auth?state=2",
      instructions: "Paste the code it shows.",
    });
    store.clearSignIn();
    expect(store.getSnapshot().signIn).toBeNull();
  });

  test("the working row keeps its object while its line is unchanged, so streaming frames do not redraw it", () => {
    const store = new ChatStore();
    store.apply(event({ type: "agent_start" }));
    store.apply(event({ type: "message_start", messageId: "m", message: assistant([]) }));
    store.apply(
      event({
        type: "message_update",
        messageId: "m",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      }),
    );
    vi.runAllTimers();
    const writing = store.getSnapshot().activity;
    expect(writing?.label).toBe("Writing");
    store.apply(
      event({
        type: "message_update",
        messageId: "m",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "more" },
      }),
    );
    vi.runAllTimers();
    expect(store.getSnapshot().activity).toBe(writing);
  });

  test("a `!` run shows running, then ends with omp's result, also before the chat's file exists", () => {
    const store = new ChatStore();
    const shell = (status: "running" | "ended", result?: Record<string, unknown>) =>
      ({
        kind: "shell",
        method: "bash",
        input: "echo hi",
        status,
        startedAt: T,
        ...(result === undefined ? {} : { result }),
      }) as unknown as ChatSessionEvent;
    store.expectShell("echo hi", true);
    store.apply(shell("running"));
    expect(store.getSnapshot().shell).toMatchObject({ input: "echo hi", excludeFromContext: true });

    store.apply(
      shell("ended", { output: "hi\n", exitCode: 0, cancelled: false, truncated: false }),
    );
    const { shell: running, entries } = store.getSnapshot();
    expect(running).toBeNull();
    expect(entries.map((entry) => entry.type === "message" && entry.message)).toEqual([
      expect.objectContaining({
        role: "bashExecution",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
        excludeFromContext: true,
      }),
    ]);
  });

  test("an ended run the file already holds is not added again (a replay of the server's earlier events)", () => {
    const store = new ChatStore();
    store.setWindow(
      [
        fileEntry("b1", {
          role: "bashExecution",
          command: "ls",
          output: "a.ts\n",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: T + 900,
        }),
      ],
      false,
    );
    store.apply({
      kind: "shell",
      method: "bash",
      input: "ls",
      status: "ended",
      startedAt: T,
      result: { output: "a.ts\n", exitCode: 0, cancelled: false, truncated: false },
    } as unknown as ChatSessionEvent);
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["b1"]);
  });

  test("an extension's widget shows without colour codes, moves to the end when set again, and goes when cleared, when the chat's process ends, or when the state read at open lacks it (#2842)", () => {
    const store = new ChatStore();
    const widgets = () =>
      store
        .getSnapshot()
        .widgets.map((widget) => `${widget.placement} ${widget.key}: ${widget.lines.join(" | ")}`);
    // The store publishes a live event at the next frame.
    const settle = () => vi.advanceTimersToNextFrame();
    store.apply(
      event({
        type: "ui_widget",
        widgetKey: "notes",
        widgetLines: ["\u001b[36m📎 2 blocks from Lab notes\u001b[39m"],
      }),
    );
    store.apply(
      event({
        type: "ui_widget",
        widgetKey: "hint",
        widgetLines: ["Below"],
        widgetPlacement: "belowEditor",
      }),
    );
    settle();
    expect(widgets()).toEqual([
      "aboveEditor notes: 📎 2 blocks from Lab notes",
      "belowEditor hint: Below",
    ]);

    // Set again: its new lines, at the end, as omp's terminal orders them; a widget may name the app it belongs to.
    store.apply(
      event({
        type: "ui_widget",
        widgetKey: "notes",
        widgetLines: ["one", "two"],
        widgetHost: "siyuan",
      }),
    );
    settle();
    expect(widgets()).toEqual(["belowEditor hint: Below", "aboveEditor notes: one | two"]);
    expect(store.getSnapshot().widgets.map((widget) => widget.host)).toEqual([undefined, "siyuan"]);

    // No lines clear it.
    store.apply(event({ type: "ui_widget", widgetKey: "hint" }));
    settle();
    expect(widgets()).toEqual(["aboveEditor notes: one | two"]);

    // The state the server keeps, read when the chat opens, replaces what this page had.
    store.restoreUiState([
      { type: "ui_status", statusKey: "build", statusText: "Running" },
      {
        type: "ui_widget",
        widgetKey: "build",
        widgetLines: ["Building…"],
        widgetPlacement: "belowEditor",
      },
    ]);
    expect(widgets()).toEqual(["belowEditor build: Building…"]);

    // The process that ran the extensions ended: nothing of theirs shows.
    store.apply({ kind: "process", status: "exited" } as unknown as ChatSessionEvent);
    settle();
    expect(widgets()).toEqual([]);
  });
});

describe("applyDelta", () => {
  test("a tool call being written shows as a placeholder and becomes the full call at its end", () => {
    const started = applyDelta(assistant([{ type: "text", text: "Let me look." }]), {
      type: "toolcall_start",
      contentIndex: 1,
    });
    expect(started.content[1]).toMatchObject({ type: "toolCall", name: "" });
    const call = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "a.ts" },
    } as const;
    const ended = applyDelta(started, { type: "toolcall_end", contentIndex: 1, toolCall: call });
    expect(ended.content).toEqual([{ type: "text", text: "Let me look." }, call]);
  });

  test("thinking deltas add up, and the end of a block sets its final text", () => {
    let message = applyDelta(assistant([]), { type: "thinking_start", contentIndex: 0 });
    message = applyDelta(message, { type: "thinking_delta", contentIndex: 0, delta: "First, " });
    message = applyDelta(message, { type: "thinking_delta", contentIndex: 0, delta: "read." });
    expect(message.content[0]).toEqual({ type: "thinking", thinking: "First, read." });
    message = applyDelta(message, {
      type: "thinking_end",
      contentIndex: 0,
      content: "First, read the file.",
    });
    expect(message.content[0]).toEqual({ type: "thinking", thinking: "First, read the file." });
  });
});
