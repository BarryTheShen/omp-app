import type {
  HostToolCall,
  HostToolDefinition,
  ToolCallAnswer,
} from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { bindChat, type EmbedChat, EmbedEndpoint, type EmbedWindow, sameSite } from "./embed";

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
    expect(endpoint.getSnapshot().origin).toBeNull();

    receive(hello({ settings: { greeting: "Ask about this page" }, context: PAGE }));
    expect(endpoint.getSnapshot()).toMatchObject({
      host: "zen",
      origin: HOST,
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
      origin: HOST,
      settings: { greeting: "Ask about this page" },
    });
  });

  test("the context goes with messages until the person leaves it out; it stays out for the same site, and comes back with another", () => {
    const { window, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello({ context: PAGE }));
    expect(endpoint.contextForMessage()).toEqual({ host: "zen", context: PAGE });
    endpoint.leaveContextOut();
    expect(endpoint.contextForMessage()).toBeNull();
    // The page changing its own title, selection or path (a page may do all three by itself) does not ask again.
    receive({ ...envelope, type: "context", context: { ...PAGE, title: "Next title" } });
    expect(endpoint.contextForMessage()).toBeNull();
    receive({ ...envelope, type: "context", context: { ...PAGE, selection: "hidden words" } });
    expect(endpoint.contextForMessage()).toBeNull();
    receive({
      ...envelope,
      type: "context",
      context: { ...PAGE, uri: "https://example.com/pushed/state?x=1" },
    });
    expect(endpoint.contextForMessage()).toBeNull();
    // Another site does.
    receive({
      ...envelope,
      type: "context",
      context: { ...PAGE, title: "Next page", uri: "https://example.org/" },
    });
    expect(endpoint.contextForMessage()?.context.title).toBe("Next page");
    receive({ ...envelope, type: "context", context: null });
    expect(endpoint.contextForMessage()).toBeNull();
    // Left out once more, and a context with no address is a new context each time.
    receive({ ...envelope, type: "context", context: PAGE });
    endpoint.leaveContextOut();
    receive({ ...envelope, type: "context", context: { kind: "note", title: "A note" } });
    expect(endpoint.contextForMessage()?.context.title).toBe("A note");
  });

  test("sameSite compares web addresses by origin and any other address as a whole", () => {
    expect(sameSite("https://example.com/a", "https://example.com/b?x#y")).toBe(true);
    expect(sameSite("https://example.com/", "http://example.com/")).toBe(false);
    expect(sameSite("https://example.com/", "https://example.com:8443/")).toBe(false);
    // A file's path is not a site: each file is its own.
    expect(sameSite("file:///work/a.ts", "file:///work/a.ts")).toBe(true);
    expect(sameSite("file:///work/a.ts", "file:///work/b.ts")).toBe(false);
    expect(sameSite("not an address", "not an address")).toBe(true);
    expect(sameSite(undefined, "https://example.com/")).toBe(false);
    expect(sameSite(undefined, undefined)).toBe(false);
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

  test("asks the host to open an address outside the panel: true once it says so, false with no host or no answer in time", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    const full = "https://app.example/?chat=1";
    // No hello yet: no host to ask, so the view opens it itself.
    await expect(endpoint.open(full, 20)).resolves.toBe(false);
    receive(hello());
    const asked = endpoint.open(full, 2_000);
    expect(sent.at(-1)).toEqual({
      message: { ...envelope, type: "open", url: full },
      origin: HOST,
    });
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    // An answer for another address, or from another origin, is not this one's.
    receive({ ...envelope, type: "opened", url: "omp-app://open" });
    receive({ ...envelope, type: "opened", url: full }, "https://other.example");
    await ticks();
    expect(settled).toBe(false);
    receive({ ...envelope, type: "opened", url: full });
    await expect(asked).resolves.toBe(true);
    // A host that does not answer: false once the wait is over.
    await expect(endpoint.open("omp-app://open", 20)).resolves.toBe(false);
  });

  test("asks the host to copy: true once it says it did, false when it could not, with no host, no answer in time, or once the view closes", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    const stop = endpoint.start();
    // No hello yet: no host to ask.
    await expect(endpoint.copy("const x = 1;", 20)).resolves.toBe(false);
    receive(hello());
    const asked = endpoint.copy("const x = 1;", 2_000);
    const request = sent.at(-1);
    expect(request).toMatchObject({
      message: { ...envelope, type: "copy", text: "const x = 1;" },
      origin: HOST,
    });
    const id = request?.message.id;
    expect(typeof id).toBe("string");
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    // An answer to another copy, or from another origin, is not this one's.
    receive({ ...envelope, type: "copied", id: "another", ok: true });
    receive({ ...envelope, type: "copied", id, ok: true }, "https://other.example");
    await ticks();
    expect(settled).toBe(false);
    receive({ ...envelope, type: "copied", id, ok: true });
    await expect(asked).resolves.toBe(true);
    // A host that could not copy.
    const refused = endpoint.copy("again", 2_000);
    receive({ ...envelope, type: "copied", id: sent.at(-1)?.message.id, ok: false });
    await expect(refused).resolves.toBe(false);
    // A host that does not answer (an extension from before copying went through it): false once the wait is over.
    await expect(endpoint.copy("silent", 20)).resolves.toBe(false);
    // The view closing ends a copy still waiting.
    const waiting = endpoint.copy("last", 2_000);
    stop();
    await expect(waiting).resolves.toBe(false);
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

  test("the project whose files are on the host comes from the first hello only; the view waits for that hello or a while", async () => {
    const { window, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    const settled = endpoint.helloSettled(60_000);
    receive(hello({ files: { project: "web", id: "0123456789abcdef" } }));
    await settled;
    expect(endpoint.getSnapshot().files).toEqual({ project: "web", id: "0123456789abcdef" });
    // Another hello in the same load moves no chat to another folder.
    receive(hello({ files: { project: "other", id: "fedcba9876543210" } }));
    receive(hello());
    expect(endpoint.getSnapshot().files).toEqual({ project: "web", id: "0123456789abcdef" });
    // A host that names no files, or never says hello: the server's own folders.
    const quiet = new EmbedEndpoint(frame().window);
    quiet.start();
    await quiet.helloSettled(5);
    expect(quiet.getSnapshot().files).toBeNull();
  });
});

/**
 * A chat that is not open yet: what the binding asked of it, and ways to know it by its id before its open answers (an
 * existing chat), to open it and to bring its link back.
 */
function chat(): EmbedChat & {
  readonly given: (readonly string[])[];
  readonly answers: { id: string; answer: ToolCallAnswer }[];
  know(threadId: string): void;
  open(threadId: string): void;
  relink(): void;
  emit(request: HostToolCall): void;
  emitCancel(id: string): void;
  /**
   * omp's `agent_start` (true) or `agent_end` (false; `continuing` when omp starts the reply's next run by itself, as
   * after a retry); the store tells its listeners either way.
   */
  work(working: boolean, continuing?: boolean): void;
} {
  const storeListeners = new Set<() => void>();
  const heldListeners = new Set<() => void>();
  const callListeners = new Set<{
    call: (request: HostToolCall) => void;
    cancel: (id: string) => void;
  }>();
  const given: (readonly string[])[] = [];
  const answers: { id: string; answer: ToolCallAnswer }[] = [];
  let threadId: string | null = null;
  let held = false;
  let working = false;
  let continuing = false;
  return {
    get threadId() {
      return threadId;
    },
    get held() {
      return held;
    },
    store: {
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
      getSnapshot: () => ({ working, continuing }),
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
    onHeld: (listener) => {
      heldListeners.add(listener);
      return () => heldListeners.delete(listener);
    },
    given,
    answers,
    know(id) {
      threadId = id;
      for (const listener of [...storeListeners]) listener();
    },
    open(id) {
      threadId = id;
      held = true;
      for (const listener of [...heldListeners]) listener();
      for (const listener of [...storeListeners]) listener();
    },
    relink() {
      held = true;
      for (const listener of [...heldListeners]) listener();
    },
    emit(request) {
      for (const listener of [...callListeners]) listener.call(request);
    },
    emitCancel(id) {
      for (const listener of [...callListeners]) listener.cancel(id);
    },
    work(now, goesOn = false) {
      working = now;
      continuing = goesOn;
      for (const listener of [...storeListeners]) listener();
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

    // While the person's message here holds the host's tools for a reply not seen to start yet, a call is from another
    // reply: it fails here, and the host never hears of it. Once the reply starts, calls go to the host again.
    endpoint.began(shown);
    shown.emit(toolCall("req-3", "read_page"));
    await ticks();
    expect(sent.filter((each) => each.message.type === "tool_call")).toHaveLength(1);
    expect(shown.answers.at(-1)).toMatchObject({ id: "req-3", answer: { isError: true } });
    shown.work(true);
    shown.emit(toolCall("req-4", "read_page"));
    expect(sent.filter((each) => each.message.type === "tool_call")).toHaveLength(2);

    receive({ ...envelope, type: "tools", tools: [READ_PAGE, { ...READ_PAGE, name: "click" }] });
    await ticks();
    expect(shown.given.at(-1)).toEqual(["read_page", "click"]);

    unbind();
    await ticks();
    expect(shown.given.at(-1)).toEqual([]);
  });

  test("gives an existing chat the host's tools only once its open has answered, not when its id is known before", async () => {
    const { window, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello({ tools: [READ_PAGE] }));
    const shown = chat();
    const unbind = bindChat(endpoint, shown);
    // Known by its id while its open is on its way: the server refuses tools for a chat this page does not hold open,
    // and a refused gift was never given again.
    shown.know("thread-1");
    await ticks();
    expect(shown.given).toEqual([]);

    shown.open("thread-1");
    await ticks();
    expect(shown.given).toEqual([["read_page"]]);
    unbind();
  });

  test("gives the host's tools again once the chat holds its view on a link that came back, and tells the host", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello({ tools: [READ_PAGE] }));
    const shown = chat();
    const unbind = bindChat(endpoint, shown);
    shown.open("thread-1");
    await ticks();
    expect(shown.given).toEqual([["read_page"]]);
    const readies = () => sent.filter((each) => each.message.type === "ready").length;
    expect(readies()).toBe(1);

    // The dropped link took the tools off the chat: they are given again, and the host hears the chat take them.
    shown.relink();
    await ticks();
    expect(shown.given).toEqual([["read_page"], ["read_page"]]);
    expect(readies()).toBe(2);

    // Unbound, a later link coming back gives nothing.
    unbind();
    await ticks();
    shown.relink();
    await ticks();
    expect(shown.given.at(-1)).toEqual([]);
  });

  /** The `turn` messages the host was sent: whether a reply runs, and whether the person's message began it. */
  const turnsIn = (sent: readonly { message: Record<string, unknown> }[]) =>
    sent
      .filter((each) => each.message.type === "turn")
      .map((each) => (each.message.sent === true ? "sent" : each.message.working));

  test("tells the host when a reply begins and ends in the chat shown, once a host said hello, and that none runs once the panel moves on", async () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    const shown = chat();
    const unbind = bindChat(endpoint, shown);
    // No host yet: nothing to tell, and nothing counts as told.
    shown.work(true);
    expect(turnsIn(sent)).toEqual([]);
    // The host says hello during the reply: it hears that one runs.
    receive(hello());
    expect(turnsIn(sent)).toEqual([true]);
    // The store changes for other reasons while the reply runs: nothing new to tell.
    shown.open("thread-1");
    await ticks();
    expect(turnsIn(sent)).toEqual([true]);
    shown.work(false);
    shown.work(true);
    expect(turnsIn(sent)).toEqual([true, false, true]);
    // The panel shows another chat while this one's reply runs: that reply holds the host's tools no more.
    unbind();
    expect(turnsIn(sent)).toEqual([true, false, true, false]);
    shown.work(false);
    expect(turnsIn(sent)).toEqual([true, false, true, false]);
  });

  test("a reply omp runs again by itself, as after a retry, does not end for the host between its runs", () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello());
    const shown = chat();
    bindChat(endpoint, shown);
    shown.work(true);
    shown.work(false, true);
    shown.work(true);
    expect(turnsIn(sent)).toEqual([false, true]);
    shown.work(false);
    expect(turnsIn(sent)).toEqual([false, true, false]);
  });

  test("the person's message holds what is in front from its send until its reply ends, though omp starts the reply later", () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello());
    const shown = chat();
    bindChat(endpoint, shown);
    endpoint.began(shown);
    expect(turnsIn(sent)).toEqual([false, "sent"]);
    // The store changes before omp's `agent_start` (the message shown, the box emptied): still idle, not an end.
    shown.work(false);
    shown.work(true);
    expect(turnsIn(sent)).toEqual([false, "sent"]);
    shown.work(false);
    expect(turnsIn(sent)).toEqual([false, "sent", false]);
  });

  test("a message that began no reply lets go of what it held; one that joined a reply begun elsewhere leaves it holding nothing", () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello());
    const shown = chat();
    bindChat(endpoint, shown);
    // omp handled it where it stood (a command): nothing runs.
    endpoint.began(shown);
    endpoint.letGo(shown);
    expect(turnsIn(sent)).toEqual([false, "sent", false]);
    // omp was busy with a reply this page had not seen start: the message joined it, and that reply holds nothing.
    endpoint.began(shown);
    shown.work(true);
    endpoint.letGo(shown);
    expect(turnsIn(sent)).toEqual([false, "sent", false, "sent", false, true]);
  });

  test("only the chat shown tells the host of its replies, and moving on lets go of what its message held", () => {
    const { window, sent, receive } = frame();
    const endpoint = new EmbedEndpoint(window);
    endpoint.start();
    receive(hello());
    const first = chat();
    const unbindFirst = bindChat(endpoint, first);
    endpoint.began(first);
    unbindFirst();
    expect(turnsIn(sent)).toEqual([false, "sent", false]);
    const second = chat();
    bindChat(endpoint, second);
    // The first chat's send ends after the panel moved on: the chat shown hears nothing of it.
    endpoint.letGo(first);
    endpoint.began(first);
    first.work(true);
    expect(turnsIn(sent)).toEqual([false, "sent", false, false]);
  });
});
