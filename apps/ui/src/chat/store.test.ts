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
