import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatSessionEvent } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  test("a message the file already holds is not added again when the live stream ends it", () => {
    const store = new ChatStore();
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T };
    store.setWindow([fileEntry("u1", user)], false);
    store.apply(event({ type: "message_end", messageId: "msg-1", message: user }));
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["u1"]);
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

  test("a command's output and omp's notifications show as notices until dismissed", () => {
    const store = new ChatStore();
    store.apply(event({ type: "command_output", text: "Active tools: bash, read" }));
    store.apply(event({ type: "ui_notify", message: "No open PRs", notifyType: "warning" }));
    store.apply(event({ type: "ui_notify", message: "Reloaded" }));
    expect(store.getSnapshot().notices.map(({ text, level }) => `${level}: ${text}`)).toEqual([
      "output: Active tools: bash, read",
      "warning: No open PRs",
      "info: Reloaded",
    ]);
    const [first] = store.getSnapshot().notices;
    if (first !== undefined) store.dismissNotice(first.id);
    expect(store.getSnapshot().notices.map((notice) => notice.text)).toEqual([
      "No open PRs",
      "Reloaded",
    ]);
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
    store.setState({
      queuedMessages: { steering: [], followUp: [] },
      todoPhases: board("pending"),
    } as never);
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
    store.setState({ queuedMessages: { steering: [], followUp: [] } } as never);
    expect(store.getSnapshot().todos).toHaveLength(1);
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
