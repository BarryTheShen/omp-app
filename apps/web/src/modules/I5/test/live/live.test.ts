import type { AppClient } from "@omp-app/client";
import type { AppFailure, RpcSessionEvent, RpcSessionPort, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { I5_LIVE_CAPABILITY } from "../../contract";
import { createLiveVoiceAdapter } from "../../live";

class FakeClient {
  readonly sends: unknown[] = [];
  readonly listeners = new Set<(payload: RpcSessionEvent, seq: number) => void>();
  async send(args: unknown): Promise<unknown> {
    this.sends.push(args);
    const command = (args as { command: { type: string } }).command;
    if (command.type === "live_start") return { voice: "test-voice" };
    if (command.type === "live_mute") return { muted: true };
    return undefined;
  }
  async subscribe() {
    return {
      stream: "A0.rpcSession/event/live-thread",
      lastSeq: 0,
      onEvent: (listener: (payload: RpcSessionEvent, seq: number) => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      unsubscribe: async () => undefined,
    };
  }
  emit(frame: Record<string, unknown>, seq = 1): void {
    const payload = { kind: "notification", frame } as unknown as RpcSessionEvent;
    for (const listener of [...this.listeners]) listener(payload, seq);
  }
}

const capabilities = { [I5_LIVE_CAPABILITY]: { state: "available" as const, via: "rpc" as const } };

function adapterFixture(fake = new FakeClient(), capabilityMap = capabilities) {
  const client = {
    port: () => fake as unknown as RpcSessionPort,
    subscribe: () => fake.subscribe(),
  } as unknown as AppClient;
  const adapter = createLiveVoiceAdapter({
    client,
    threadId: "live-thread" as ThreadId,
    capabilities: capabilityMap,
    sessionIdFactory: () => "session-1",
    levelIntervalMs: 5,
  });
  return { adapter, fake };
}

describe("I5 live RPC adapter", () => {
  test("starts, stops, mutes and gates missing live capability", async () => {
    const { adapter, fake } = adapterFixture();
    await adapter.start({ voice: "test-voice" });
    await adapter.mute({ muted: true });
    await adapter.stop();
    expect(
      fake.sends.map((entry) => (entry as { command: { type: string } }).command.type),
    ).toEqual(["live_stop", "live_start", "live_mute", "live_stop"]);
    await adapter.dispose();

    const unavailable = adapterFixture(new FakeClient(), {});
    await expect(unavailable.adapter.start()).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await unavailable.adapter.dispose();
  });

  test("replaces interim transcripts, emits only final messages and throttles levels", async () => {
    const { adapter, fake } = adapterFixture();
    const states: number[] = [];
    const finals: string[] = [];
    adapter.subscribe((state) => states.push(state.levels.input));
    adapter.onFinalTranscript((message) => {
      const part = Array.isArray(message.content) ? message.content[0] : undefined;
      if (part && part.type === "text") finals.push(part.text);
    });
    await adapter.start();
    fake.emit({ type: "live_transcript", role: "user", turn: 0, text: "hel", final: false });
    fake.emit({ type: "live_transcript", role: "user", turn: 0, text: "hello", final: true });
    fake.emit({ type: "live_transcript", role: "user", turn: 0, text: "hello again", final: true });
    fake.emit({ type: "live_levels", input: 0.1, output: 0.2 });
    fake.emit({ type: "live_levels", input: 0.8, output: 0.9 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(adapter.getSnapshot().transcripts).toEqual([
      { sessionId: "session-1", role: "user", turn: 0, text: "hello again", final: true },
    ]);
    expect(finals).toEqual(["hello"]);
    expect(adapter.getSnapshot().levels).toEqual({ input: 0.8, output: 0.9 });
    expect(states.length).toBeLessThan(8);
    await adapter.dispose();
  });

  test("maps live_end failures to AppFailure and cleans subscriptions/timers", async () => {
    const { adapter, fake } = adapterFixture();
    const failures: AppFailure[] = [];
    adapter.onFailure((error) => failures.push(error));
    await adapter.start();
    fake.emit({ type: "live_end", error: "provider stopped" });
    expect(adapter.getSnapshot()).toMatchObject({ phase: "error", error: "provider stopped" });
    expect(failures).toMatchObject([{ appError: { code: "omp_error" } }]);
    await adapter.dispose();
    expect(fake.listeners.size).toBe(0);
    fake.emit({ type: "live_phase", phase: "listening" });
    expect(adapter.getSnapshot().phase).toBe("error");
  });
});
