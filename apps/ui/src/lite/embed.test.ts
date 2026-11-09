import type {
  HostToolCall,
  HostToolDefinition,
  ToolCallAnswer,
} from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { bindChat, type EmbedChat, EmbedEndpoint, type EmbedWindow } from "./embed";

const HOST = "https://panel.example";

/** A frame's window: what its parent was sent, and a way to have a page send it a message. */
function frame() {
  const sent: { message: Record<string, unknown>; origin: string }[] = [];
  const parent = {
    postMessage: (message: unknown, origin: string) =>
      sent.push({ message: message as Record<string, unknown>, origin }),
  };
  const listeners = new Set<(event: MessageEvent) => void>();
  const window: EmbedWindow = {
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const receive = (data: unknown, origin = HOST, source: unknown = parent): void => {
    for (const listener of [...listeners])
      listener({ data, origin, source } as unknown as MessageEvent);
  };
  return { window, sent, receive, listeners };
}

const envelope = { omp: "embed", v: 1 } as const;
const READ_PAGE = {
  name: "read_page",
  description: "Reads the page you are looking at",
  parameters: { type: "object" },
};
const PAGE = { kind: "page", title: "Example Domain", uri: "https://example.com/" };

function hello(extra: Record<string, unknown> = {}) {
  return { ...envelope, type: "hello", host: "zen", ...extra };
}

function toolCall(id: string, toolName: string): HostToolCall {
  return {
    id,
    method: "tool.call",
    params: { toolCallId: `${id}-c`, toolName, arguments: { part: "all" } },
  } as HostToolCall;
}

/** Lets promise chains run. */
const ticks = async (count = 5): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

describe("the lite view's end of the embed protocol", () => {
  test("says it listens, then hears only the framing window, from the origin of its first hello", () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    expect(sent).toEqual([{ message: { ...envelope, type: "listening" }, origin: "*" }]);

    // Another window, and a message that is not the protocol's, change nothing.
    receive(hello(), HOST, {});
    receive({ hello: true });
    expect(endpoint.getSnapshot().host).toBeNull();

    receive(hello({ settings: { greeting: "Ask about this page" }, context: PAGE }));
    expect(endpoint.getSnapshot()).toMatchObject({
      host: "zen",
      settings: { greeting: "Ask about this page" },
      context: PAGE,
    });
    // Another origin, even through the same window, is not heard any more.
    receive(
      { ...envelope, type: "settings", settings: { greeting: "pwned" } },
      "https://other.example",
    );
    receive(hello({ host: "other" }), "https://other.example");
    expect(endpoint.getSnapshot()).toMatchObject({
      host: "zen",
      settings: { greeting: "Ask about this page" },
    });
  });

  test("the context goes with messages until the person leaves it out, and again once the host says another", () => {
    const { window, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello({ context: PAGE }));
    expect(endpoint.contextForMessage()).toEqual({ host: "zen", context: PAGE });
    endpoint.leaveContextOut();
    expect(endpoint.contextForMessage()).toBeNull();
    receive({ ...envelope, type: "context", context: { ...PAGE, title: "Next page" } });
    expect(endpoint.contextForMessage()?.context.title).toBe("Next page");
    receive({ ...envelope, type: "context", context: null });
    expect(endpoint.contextForMessage()).toBeNull();
  });

  test("a tool call goes to the host and its answer comes back; omp giving up tells the host; the panel closing ends the rest", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    const stop = endpoint.start();
    receive(hello());

    const answered = endpoint.call(toolCall("req-1", "read_page"));
    expect(sent.at(-1)).toEqual({
      message: {
        ...envelope,
        type: "tool_call",
        callId: "req-1",
        name: "read_page",
        arguments: { part: "all" },
      },
      origin: HOST,
    });
    receive({
      ...envelope,
      type: "tool_result",
      callId: "req-1",
      result: { content: [{ type: "text", text: "the page" }] },
    });
    await expect(answered).resolves.toEqual({ content: [{ type: "text", text: "the page" }] });

    void endpoint.call(toolCall("req-2", "read_page"));
    endpoint.cancel("req-2");
    expect(sent.at(-1)?.message).toEqual({ ...envelope, type: "tool_cancel", callId: "req-2" });

    const waiting = endpoint.call(toolCall("req-3", "read_page"));
    stop();
    await expect(waiting).resolves.toMatchObject({ isError: true });
  });

  test("a panel whose host keeps its key signs in with the one its hello brings, and hands a new one to that host only", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window, true);
    endpoint.start();
    expect(endpoint.keepsCredential).toBe(true);
    const waiting = endpoint.credential(60_000);
    // Another window's hello brings no key the panel would use.
    receive(hello({ credential: "stolen" }), "https://other.example", {});
    receive(hello({ credential: "key-1" }));
    await expect(waiting).resolves.toBe("key-1");
    // Only the first hello's key: the page signs in once per load.
    receive(hello({ credential: "key-2" }));
    await expect(endpoint.credential(60_000)).resolves.toBe("key-1");

    endpoint.keepCredential("key-3");
    expect(sent.at(-1)).toEqual({
      message: { ...envelope, type: "credential", key: "key-3" },
      origin: HOST,
    });
  });

  test("with no hello in time the panel connects without a key, and hands a new key to no one", async () => {
    const { window, sent } = frame();
    const endpoint = new EmbedEndpoint(window, true);
    endpoint.start();
    await expect(endpoint.credential(5)).resolves.toBeNull();
    endpoint.keepCredential("key-1");
    expect(sent).toEqual([{ message: { ...envelope, type: "listening" }, origin: "*" }]);
  });
});

/** A chat that is not open yet: what the binding asked of it, and a way to open it. */
function chat(): EmbedChat & {
  readonly given: (readonly string[])[];
  readonly answers: { id: string; answer: ToolCallAnswer }[];
  open(threadId: string): void;
  emit(request: HostToolCall): void;
  emitCancel(id: string): void;
} {
  const storeListeners = new Set<() => void>();
  const callListeners = new Set<{
    call: (request: HostToolCall) => void;
    cancel: (id: string) => void;
  }>();
  const given: (readonly string[])[] = [];
  const answers: { id: string; answer: ToolCallAnswer }[] = [];
  let threadId: string | null = null;
  return {
    get threadId() {
      return threadId;
    },
    store: {
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
    setHostTools: async (_owner: string, tools: readonly HostToolDefinition[]) => {
      given.push(tools.map((tool) => tool.name));
      return tools.map((tool) => tool.name);
    },
    onHostToolCall: (call, cancel) => {
      const listener = { call, cancel };
      callListeners.add(listener);
      return () => callListeners.delete(listener);
    },
    answerToolCall: async (id, answer) => {
      answers.push({ id, answer });
    },
    given,
    answers,
    open(id) {
      threadId = id;
      for (const listener of [...storeListeners]) listener();
    },
    emit(request) {
      for (const listener of [...callListeners]) listener.call(request);
    },
    emitCancel(id) {
      for (const listener of [...callListeners]) listener.cancel(id);
    },
  };
}

describe("the chat the panel shows, bound to its host", () => {
  test("gets the host's tools once open and again when they change, hands their calls over, and loses them when the panel moves on", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello({ tools: [READ_PAGE] }));
    const shown = chat();
    const unbind = bindChat(endpoint, shown);
    await ticks();
    // Not open yet: nothing to give the tools to.
    expect(shown.given).toEqual([]);

    shown.open("thread-1");
    await ticks();
    expect(shown.given).toEqual([["read_page"]]);
    expect(sent.at(-1)?.message).toEqual({
      ...envelope,
      type: "ready",
      chat: "thread-1",
      tools: ["read_page"],
    });

    // A call of the host's tool goes to the host, and its answer to the chat; another tool's call is not this page's.
    shown.emit(toolCall("req-1", "read_page"));
    shown.emit(toolCall("req-2", "write"));
    expect(sent.filter((each) => each.message.type === "tool_call")).toHaveLength(1);
    receive({
      ...envelope,
      type: "tool_result",
      callId: "req-1",
      result: { content: [{ type: "text", text: "Example Domain" }] },
    });
    await ticks();
    expect(shown.answers).toEqual([
      { id: "req-1", answer: { content: [{ type: "text", text: "Example Domain" }] } },
    ]);

    receive({ ...envelope, type: "tools", tools: [READ_PAGE, { ...READ_PAGE, name: "click" }] });
    await ticks();
    expect(shown.given.at(-1)).toEqual(["read_page", "click"]);

    unbind();
    await ticks();
    expect(shown.given.at(-1)).toEqual([]);
  });
});
