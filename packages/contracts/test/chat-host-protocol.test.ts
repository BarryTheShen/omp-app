import { describe, expect, test } from "bun:test";
import {
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
});
