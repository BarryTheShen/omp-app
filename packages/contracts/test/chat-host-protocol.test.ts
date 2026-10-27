import { describe, expect, test } from "bun:test";
import {
  HOST_METHOD_ANSWERS,
  isChatHostHostMethod,
  isChatHostMethod,
  parseChatHostParams,
  parseHostLine,
  parseServerLine,
} from "../src/chat-host/protocol";

describe("lines from the chat host", () => {
  test("each kind the host writes is read, and an event keeps omp's own fields", () => {
    const hello = parseHostLine(
      JSON.stringify({
        kind: "hello",
        protocol: 1,
        ompVersion: "18.12.6",
        methods: ["prompt"],
        session: { id: "s1", file: null, cwd: "/w" },
      }),
    );
    expect(hello.ok && hello.value.kind).toBe("hello");

    const failed = parseHostLine(
      JSON.stringify({
        kind: "response",
        id: "7",
        ok: false,
        error: { code: "failed", message: "x" },
      }),
    );
    expect(failed.ok && failed.value.kind === "response" && !failed.value.ok).toBe(true);

    const update = {
      type: "message_update",
      messageId: "msg-1",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    };
    const event = parseHostLine(JSON.stringify({ kind: "event", seq: 3, event: update }));
    expect(event.ok && event.value.kind === "event" && event.value.event).toEqual(update);
  });

  test("a line that is not one of the host's messages is refused", () => {
    for (const line of [
      "not json",
      "[]",
      JSON.stringify({ kind: "frame", type: "response" }),
      JSON.stringify({ kind: "event", seq: 0, event: { type: "agent_start" } }),
      JSON.stringify({ kind: "event", seq: 1, event: { kind: "agent_start" } }),
      JSON.stringify({ kind: "response", id: "1", ok: false }),
      JSON.stringify({ kind: "response", id: "", ok: true, result: {} }),
    ]) {
      expect(parseHostLine(line).ok).toBe(false);
    }
  });

  test("a refusal names the problem without repeating the line, which may hold a secret", () => {
    // Built from parts, so the repository holds no line that looks like a key.
    const secret = ["sk", "ant", "thisIsNotForLogs"].join("-");
    const result = parseHostLine(
      JSON.stringify({ kind: "hello", protocol: "one", ompVersion: secret }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).not.toContain(secret);
  });
});

describe("requests from the server", () => {
  test("a request is read with its params left for the method to check", () => {
    const request = parseServerLine(
      JSON.stringify({ kind: "request", id: "1", method: "prompt", params: { text: "hi" } }),
    );
    expect(request.ok && request.value).toEqual({
      kind: "request",
      id: "1",
      method: "prompt",
      params: { text: "hi" },
    });
    expect(parseServerLine(JSON.stringify({ kind: "request", id: "1" })).ok).toBe(false);
  });

  test("only the protocol's own methods are methods, never an object's inherited names", () => {
    expect(isChatHostMethod("prompt")).toBe(true);
    for (const name of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "negotiate_protocol",
    ]) {
      expect(isChatHostMethod(name)).toBe(false);
    }
  });

  test("a prompt needs its text; images and the queueing choice are checked", () => {
    expect(parseChatHostParams("prompt", undefined).ok).toBe(false);
    expect(parseChatHostParams("prompt", { text: "hi", streamingBehavior: "now" }).ok).toBe(false);
    expect(
      parseChatHostParams("prompt", { text: "hi", images: [{ type: "image", data: "AA==" }] }).ok,
    ).toBe(false);
    const ok = parseChatHostParams("prompt", {
      text: "hi",
      images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      streamingBehavior: "followUp",
    });
    expect(ok.ok && ok.value.streamingBehavior).toBe("followUp");
  });

  test("a method without arguments accepts a request that sends none", () => {
    expect(parseChatHostParams("get_state", undefined).ok).toBe(true);
    expect(parseChatHostParams("set_event_options", { messageUpdates: "partial" }).ok).toBe(false);
  });

  test("a queue edit names one of omp's two queues", () => {
    expect(
      parseChatHostParams("remove_queued_message", { message: "hi", queue: "followUp" }).ok,
    ).toBe(true);
    expect(parseChatHostParams("remove_queued_message", { message: "hi", queue: "later" }).ok).toBe(
      false,
    );
    expect(parseChatHostParams("remove_queued_message", { message: "hi" }).ok).toBe(false);
  });

  test("a shell or Python run needs something to run", () => {
    expect(parseChatHostParams("bash", { command: "ls", excludeFromContext: true }).ok).toBe(true);
    expect(parseChatHostParams("bash", { command: "" }).ok).toBe(false);
    expect(parseChatHostParams("python", { code: "" }).ok).toBe(false);
    expect(parseChatHostParams("python", { code: "print(1)", excludeFromContext: "yes" }).ok).toBe(
      false,
    );
  });

  test("a model change names both the provider and the model", () => {
    expect(parseChatHostParams("set_model", { provider: "anthropic", modelId: "m" }).ok).toBe(true);
    expect(parseChatHostParams("set_model", { provider: "anthropic" }).ok).toBe(false);
    expect(parseChatHostParams("set_model", { provider: "", modelId: "m" }).ok).toBe(false);
  });

  test("a thinking level is one omp's session takes, auto and inherit included", () => {
    for (const level of ["off", "max", "auto", "inherit"]) {
      expect(parseChatHostParams("set_thinking_level", { level }).ok).toBe(true);
    }
    expect(parseChatHostParams("set_thinking_level", { level: "turbo" }).ok).toBe(false);
    expect(parseChatHostParams("set_thinking_level", { level: "High" }).ok).toBe(false);
  });

  test("a switch takes true or false, never a word", () => {
    expect(parseChatHostParams("set_auto_compaction", { enabled: false }).ok).toBe(true);
    expect(parseChatHostParams("set_fast_mode", { enabled: "yes" }).ok).toBe(false);
    expect(parseChatHostParams("set_slow_mode", {}).ok).toBe(false);
  });

  test("a todo edit uses omp's statuses and keeps a task's notes", () => {
    const task = {
      content: "Fix the check",
      status: "blocked" as const,
      blocker: "CI",
      notes: ["seen twice"],
    };
    expect(parseChatHostParams("set_todos", { phases: [{ name: "Plan", tasks: [task] }] })).toEqual(
      {
        ok: true,
        value: { phases: [{ name: "Plan", tasks: [task] }] },
      },
    );
    const done = { ...task, status: "done" };
    expect(parseChatHostParams("set_todos", { phases: [{ name: "Plan", tasks: [done] }] }).ok).toBe(
      false,
    );
    expect(
      parseChatHostParams("set_todos", {
        phases: [{ name: "Plan", tasks: [{ status: "pending" }] }],
      }).ok,
    ).toBe(false);
  });

  test("a message page asks for 1 to 256 whole messages, from a cursor that is not empty", () => {
    expect(parseChatHostParams("get_messages_page", { limit: 256 }).ok).toBe(true);
    for (const limit of [0, 257, 2.5]) {
      expect(parseChatHostParams("get_messages_page", { limit }).ok).toBe(false);
    }
    expect(parseChatHostParams("get_messages_page", { cursor: "" }).ok).toBe(false);
  });

  test("a fork, a branch and a rewind name the entry they start from", () => {
    for (const method of ["fork", "branch", "navigate_tree"] as const) {
      expect(parseChatHostParams(method, { entryId: "b8e8c20d" }).ok).toBe(true);
      expect(parseChatHostParams(method, { entryId: "" }).ok).toBe(false);
      expect(parseChatHostParams(method, {}).ok).toBe(false);
    }
  });

  test("a sign-in names its provider", () => {
    expect(parseChatHostParams("login", { providerId: "anthropic" }).ok).toBe(true);
    expect(parseChatHostParams("login", { providerId: "" }).ok).toBe(false);
    expect(parseChatHostParams("login", {}).ok).toBe(false);
  });
});

describe("the host's dialogs", () => {
  test("the host may ask too, and the server's answer is read as a response", () => {
    const asked = parseHostLine(
      JSON.stringify({
        kind: "request",
        id: "host-1",
        method: "ui.confirm",
        params: { title: "Go on?", message: "It runs the check" },
      }),
    );
    expect(asked.ok && asked.value.kind).toBe("request");
    const answered = parseServerLine(
      JSON.stringify({ kind: "response", id: "host-1", ok: true, result: { confirmed: true } }),
    );
    expect(answered.ok && answered.value.kind).toBe("response");
  });

  test("only the dialogs are the host's methods, never the server's or an object's inherited names", () => {
    expect(isChatHostHostMethod("ui.approve")).toBe(true);
    expect(isChatHostHostMethod("prompt")).toBe(false);
    expect(isChatHostHostMethod("toString")).toBe(false);
  });

  test("an answer is checked against its dialog: omp's typed approvals, and a closed dialog", () => {
    const approve = HOST_METHOD_ANSWERS["ui.approve"];
    expect(approve.safeParse({ grant: "folder", always: true }).success).toBe(true);
    expect(approve.safeParse("once").success).toBe(true);
    expect(approve.safeParse({ grant: "anywhere", always: true }).success).toBe(false);
    expect(approve.safeParse("Approve Once").success).toBe(false);
    const confirm = HOST_METHOD_ANSWERS["ui.confirm"];
    expect(confirm.safeParse({ cancelled: true, timedOut: true }).success).toBe(true);
    expect(confirm.safeParse({ confirmed: "yes" }).success).toBe(false);
  });
});
