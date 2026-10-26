import { describe, expect, test } from "bun:test";
import { ChatHostClient, ChatHostRequestError, type LineDuplex } from "./client";

/** The host's side of the pipe: records what the client wrote, and sends what a test writes. */
class FakeHost implements LineDuplex {
  readonly requests: { id: string; method: string; params: unknown }[] = [];
  readonly #chunk = new Set<(chunk: Uint8Array) => void>();
  readonly #close = new Set<(cause?: unknown) => void>();

  writeLine(line: string): void {
    this.requests.push(JSON.parse(line));
  }
  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunk.add(listener);
    return () => this.#chunk.delete(listener);
  }
  onClose(listener: (cause?: unknown) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }
  send(text: string): void {
    for (const listener of this.#chunk) listener(new TextEncoder().encode(text));
  }
  line(message: object): void {
    this.send(`${JSON.stringify(message)}\n`);
  }
  end(): void {
    for (const listener of this.#close) listener();
  }
}

const hello = {
  kind: "hello",
  protocol: 1,
  ompVersion: "18.12.6",
  methods: ["prompt", "abort", "get_state", "set_event_options"],
  session: { id: "s1", file: null, cwd: "/w" },
};

describe("the chat host client", () => {
  test("answers reach their requests in any order, and events arrive in the order written", async () => {
    const host = new FakeHost();
    const client = new ChatHostClient(host);
    const seen: string[] = [];
    client.onEvent((event, seq) => seen.push(`${seq}:${event.type}`));
    host.send(`${JSON.stringify(hello).slice(0, 20)}`);
    host.send(`${JSON.stringify(hello).slice(20)}\n`);
    expect((await client.hello).session.id).toBe("s1");

    const prompt = client.request("prompt", { text: "hi" });
    const state = client.request("get_state", {});
    const [promptId, stateId] = host.requests.map((request) => request.id);
    host.line({ kind: "event", seq: 1, event: { type: "agent_start" } });
    host.line({ kind: "response", id: stateId, ok: true, result: { isStreaming: true } });
    host.line({ kind: "event", seq: 2, event: { type: "turn_start" } });
    host.line({ kind: "response", id: promptId, ok: true, result: { resultFollows: true } });
    expect(await state).toEqual({ isStreaming: true } as never);
    expect(await prompt).toEqual({ resultFollows: true });
    expect(seen).toEqual(["1:agent_start", "2:turn_start"]);
  });

  test("a refused request rejects with the host's code and message", async () => {
    const host = new FakeHost();
    const client = new ChatHostClient(host);
    const prompt = client.request("prompt", { text: "" });
    host.line({
      kind: "response",
      id: host.requests[0]?.id,
      ok: false,
      error: { code: "failed", message: "Agent is busy" },
    });
    await expect(prompt).rejects.toEqual(new ChatHostRequestError("failed", "Agent is busy"));
  });

  test("when the host ends, open requests and a missing hello reject as closed, and later requests too", async () => {
    const host = new FakeHost();
    const client = new ChatHostClient(host);
    const open = client.request("abort", {});
    host.end();
    await expect(open).rejects.toMatchObject({ code: "closed" });
    await expect(client.hello).rejects.toMatchObject({ code: "closed" });
    await expect(client.request("get_state", {})).rejects.toMatchObject({ code: "closed" });
  });

  test("a line that is not the host's message is reported and skipped", async () => {
    const host = new FakeHost();
    const invalid: string[] = [];
    const client = new ChatHostClient(host, { onInvalidLine: (reason) => invalid.push(reason) });
    host.send("Warning: something an extension printed\n");
    host.line(hello);
    await client.hello;
    expect(invalid).toHaveLength(1);
  });
});
