import { describe, expect, test } from "bun:test";
import type { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { checkHostTools, HostTools, HostUriSchemes } from "./host-tools";
import { HostRequests } from "./ui-context";

/** Host requests the test answers; every request and event is kept. */
function harness() {
  const sent: { id: string; method: string; params: unknown }[] = [];
  const events: { type: string; requestId: string }[] = [];
  const requests = new HostRequests((message) => {
    sent.push(message as { id: string; method: string; params: unknown });
    return true;
  });
  const answer = (index: number, result: unknown) =>
    requests.settle({ kind: "response", id: sent[index]?.id ?? "", ok: true, result });
  return {
    sent,
    events,
    requests,
    answer,
    emit: (event: { type: string; requestId: string }) => events.push(event),
  };
}

/** A router that keeps what is registered; `local` is omp's own. */
function fakeRouter() {
  const handlers = new Map<string, ProtocolHandler>();
  const router = {
    isBuiltin: (scheme: string) => scheme === "local",
    register: (handler: ProtocolHandler) => handlers.set(handler.scheme, handler),
    unregister: (scheme: string) => handlers.delete(scheme),
  };
  return { handlers, router: router as unknown as InternalUrlRouter };
}

describe("the app's tool definitions", () => {
  test("names and descriptions are trimmed, a label falls back to the name, and omp's load mode applies", () => {
    expect(
      checkHostTools([
        { name: " weather ", description: " Says the weather ", parameters: { type: "object" } },
        { name: "read", label: "Read", description: "Reads", parameters: {} },
      ]),
    ).toEqual([
      {
        name: "weather",
        label: "weather",
        description: "Says the weather",
        parameters: { type: "object" },
        hidden: false,
        loadMode: "discoverable",
      },
      {
        name: "read",
        label: "Read",
        description: "Reads",
        parameters: {},
        hidden: false,
        loadMode: "essential",
      },
    ]);
  });
});

describe("the app's URI schemes", () => {
  test("a scheme is lower-cased; a bad name or one of omp's own is refused, and nothing changes", () => {
    const { handlers, router } = fakeRouter();
    const { requests, emit } = harness();
    const schemes = new HostUriSchemes(requests, emit, router);
    expect(schemes.set([{ scheme: " TestDB " }])).toEqual(["testdb"]);
    expect(() => schemes.set([{ scheme: "2fa" }])).toThrow(
      "Host URI scheme contains invalid characters: 2fa",
    );
    expect(() => schemes.set([{ scheme: "local" }])).toThrow(
      "Host URI scheme is reserved by OMP: local://",
    );
    expect([...handlers.keys()]).toEqual(["testdb"]);
  });

  test("a scheme no longer listed leaves the router, and clearing takes the rest out", () => {
    const { handlers, router } = fakeRouter();
    const { requests, emit } = harness();
    const schemes = new HostUriSchemes(requests, emit, router);
    schemes.set([{ scheme: "one" }, { scheme: "two", writable: true }]);
    expect(handlers.get("two")?.write).toBeDefined();
    expect(handlers.get("one")?.write).toBeUndefined();
    schemes.set([{ scheme: "two" }]);
    expect([...handlers.keys()]).toEqual(["two"]);
    schemes.clear();
    expect(handlers.size).toBe(0);
  });
});

describe("calls of the app's tools", () => {
  test("an error answer fails the call with its text, and a plain one is the call's result", async () => {
    const { requests, emit, answer } = harness();
    const tools = new HostTools(requests, emit);
    const failing = tools.call("weather", "call-1", { city: "Atlantis" }, undefined, undefined);
    answer(0, { content: [{ type: "text", text: "no such city" }], isError: true });
    await expect(failing).rejects.toThrow("no such city");
    const working = tools.call("weather", "call-2", { city: "Paris" }, undefined, undefined);
    answer(1, { content: [{ type: "text", text: "sunny" }], details: { celsius: 21 } });
    expect(await working).toEqual({
      content: [{ type: "text", text: "sunny" }],
      details: { celsius: 21 },
    });
  });

  test("an abort fails the call, tells the app, and a late answer changes nothing", async () => {
    const { requests, emit, answer, sent, events } = harness();
    const tools = new HostTools(requests, emit);
    const controller = new AbortController();
    const call = tools.call("weather", "call-1", {}, controller.signal, undefined);
    controller.abort();
    await expect(call).rejects.toThrow('Host tool "weather" was aborted');
    expect(events).toEqual([{ type: "tool_cancel", requestId: sent[0]?.id ?? "" }]);
    expect(answer(0, { content: [] })).toBe(false);
  });

  test("progress reaches a running call only", async () => {
    const { requests, emit, answer, sent } = harness();
    const tools = new HostTools(requests, emit);
    const updates: unknown[] = [];
    const call = tools.call("weather", "call-1", {}, undefined, (partial) => updates.push(partial));
    const id = sent[0]?.id ?? "";
    expect(tools.update(id, { content: [{ type: "text", text: "half way" }] })).toBe(true);
    answer(0, { content: [] });
    await call;
    expect(tools.update(id, { content: [] })).toBe(false);
    expect(updates).toEqual([{ content: [{ type: "text", text: "half way" }] }]);
  });
});
