import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type ChatSessionEvent,
  type ChatSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { I5_LIVE_CAPABILITY } from "../../contract";
import { createLiveVoiceSession, type FinishedVoiceTurn } from "../../live/live-session";

/** A fake chat host: it answers the live requests as omp does, and lets a test emit live events. */
class FakeOmp {
  readonly sends: unknown[] = [];
  readonly listeners = new Set<(payload: ChatSessionEvent, seq: number) => void>();
  refuseStart: AppFailure | undefined;
  refuseStop: AppFailure | undefined;
  /** omp runs one live session at a time: a live_start while one is active is refused, and live_stop or live_end ends it. */
  active = false;
  async request(args: unknown): Promise<unknown> {
    this.sends.push(args);
    const { method, params } = args as { method: string; params: { muted?: boolean } };
    if (method === "live_start") {
      if (this.refuseStart !== undefined) throw this.refuseStart;
      if (this.active) {
        throw new AppFailure({
          code: "omp_error",
          message: "A live session is already active",
          retryable: false,
        });
      }
      this.active = true;
      return { voice: "sol" };
    }
    if (method === "live_stop") {
      if (this.refuseStop !== undefined) throw this.refuseStop;
      this.active = false;
      return {};
    }
    if (method === "live_mute") return { muted: params.muted === true };
    return {};
  }
  async subscribe() {
    return {
      stream: "A0.chatSession/event/live-thread",
      lastSeq: 0,
      onEvent: (listener: (payload: ChatSessionEvent, seq: number) => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      unsubscribe: async () => undefined,
    };
  }
  emit(event: Record<string, unknown>, seq = 1): void {
    // omp's session ends on its own live_end, so a later start is not refused.
    if (event.type === "live_end") this.active = false;
    const payload = { kind: "event", event } as unknown as ChatSessionEvent;
    for (const listener of [...this.listeners]) listener(payload, seq);
  }
  commandTypes(): string[] {
    return this.sends.map((entry) => (entry as { method: string }).method);
  }
}

const available: CapabilityMap = {
  [I5_LIVE_CAPABILITY]: { state: "available" as const, via: "omp" as const },
};

function sessionFixture(omp: FakeOmp, capabilities: CapabilityMap = available) {
  const client = {
    port: () => omp as unknown as ChatSessionPort,
    subscribe: () => omp.subscribe(),
  } as unknown as AppClient;
  const admitted: FinishedVoiceTurn[] = [];
  const session = createLiveVoiceSession({
    client,
    threadId: "live-thread" as ThreadId,
    capabilities,
    admitTurn: (turn) => admitted.push(turn),
  });
  return { session, admitted };
}

describe("I5 live voice session", () => {
  test("start, mute and stop reach omp as live_start, live_mute and live_stop", async () => {
    const omp = new FakeOmp();
    const { session } = sessionFixture(omp);
    await session.start();
    await session.setMuted(true);
    expect(session.getSnapshot()).toMatchObject({ phase: "muted", muted: true, error: null });
    await session.stop();
    expect(omp.commandTypes()).toEqual(["live_stop", "live_start", "live_mute", "live_stop"]);
    await session.close();
  });

  test("a finished turn is admitted once, and a partial one is not", async () => {
    const omp = new FakeOmp();
    const { session, admitted } = sessionFixture(omp);
    await session.start();
    omp.emit({ type: "live_transcript", role: "user", turn: 0, text: "hel", final: false });
    omp.emit({ type: "live_transcript", role: "user", turn: 0, text: "hello", final: true });
    omp.emit({ type: "live_transcript", role: "user", turn: 0, text: "hello", final: true }, 2);
    omp.emit(
      { type: "live_transcript", role: "assistant", turn: 1, text: "Hi there.", final: true },
      3,
    );
    expect(admitted).toEqual([
      expect.objectContaining({ role: "user", turn: 0, text: "hello" }),
      expect.objectContaining({ role: "assistant", turn: 1, text: "Hi there." }),
    ]);
    await session.close();
  });

  test("a start that omp refuses is kept in the state, with omp's words", async () => {
    const omp = new FakeOmp();
    omp.refuseStart = new AppFailure({
      code: "omp_error",
      message: "No Codex OAuth credential is available for a live call.",
      retryable: true,
    });
    const { session } = sessionFixture(omp);
    await session.start();
    expect(session.getSnapshot().error).toBe(
      "No Codex OAuth credential is available for a live call.",
    );
    await session.close();
  });

  test("an action the missing capability refuses is kept in the state, and nothing is sent", async () => {
    const omp = new FakeOmp();
    const { session } = sessionFixture(omp, {});
    await session.start();
    expect(session.getSnapshot().error).toBe("Live voice is unavailable for this session");
    expect(omp.sends).toEqual([]);
    await session.close();
  });

  test("a live_end error is shown as the state's error", async () => {
    const omp = new FakeOmp();
    const { session } = sessionFixture(omp);
    await session.start();
    omp.emit({ type: "live_end", error: "provider stopped" });
    expect(session.getSnapshot()).toMatchObject({ phase: "error", error: "provider stopped" });
    await session.close();
  });

  test("leaving a live session sends live_stop, so omp ends the session", async () => {
    const omp = new FakeOmp();
    const { session } = sessionFixture(omp);
    await session.start();
    await session.close();
    expect(omp.active).toBe(false);
    expect(omp.commandTypes()).toEqual(["live_stop", "live_start", "live_stop"]);
  });

  test("leaving a session that is not live sends nothing", async () => {
    const omp = new FakeOmp();
    await sessionFixture(omp).session.close();
    expect(omp.sends).toEqual([]);
  });

  test("leaving a session that omp has ended, or that failed, sends nothing more", async () => {
    const omp = new FakeOmp();
    const ended = sessionFixture(omp).session;
    await ended.start();
    omp.emit({ type: "live_end" });
    const beforeEnded = omp.sends.length;
    await ended.close();
    expect(omp.sends.length).toBe(beforeEnded);

    const failed = sessionFixture(omp).session;
    await failed.start();
    omp.emit({ type: "live_end", error: "provider stopped" });
    const beforeFailed = omp.sends.length;
    await failed.close();
    expect(omp.sends.length).toBe(beforeFailed);
  });

  test("a session an earlier page left behind is ended before a new start, so the start is not refused", async () => {
    const omp = new FakeOmp();
    // The earlier page reloaded before it closed its session: omp still holds that session.
    await sessionFixture(omp).session.start();
    const { session } = sessionFixture(omp);
    await session.start();
    expect(session.getSnapshot()).toMatchObject({ phase: "connecting", error: null });
    expect(omp.commandTypes()).toEqual(["live_stop", "live_start", "live_stop", "live_start"]);
    await session.close();
  });

  test("a stop omp refuses does not keep the chat from closing", async () => {
    const omp = new FakeOmp();
    const { session } = sessionFixture(omp);
    await session.start();
    omp.refuseStop = new AppFailure({ code: "omp_error", message: "omp is busy", retryable: true });
    await expect(session.close()).resolves.toBeUndefined();
    expect(omp.listeners.size).toBe(0);
  });
});
