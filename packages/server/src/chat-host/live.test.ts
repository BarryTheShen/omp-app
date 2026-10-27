import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveEvent } from "@omp-app/contracts/chat-host";
import { type LiveController, LiveVoice } from "./live";

/** omp's controller as the bridge drives it: the callbacks it was given, and its start, stop and mute. */
class StandInController implements LiveController {
  muted = false;
  stops = 0;
  constructor(
    readonly options: LiveSessionControllerOptions,
    private readonly startFailure?: Error,
  ) {}
  async start(): Promise<void> {
    if (this.startFailure) throw this.startFailure;
  }
  async stop(): Promise<void> {
    this.stops++;
  }
  toggleMute(): void {
    this.muted = !this.muted;
  }
}

function bridge(
  options: { overrides?: Record<string, unknown>; startFailure?: Error; levelsMs?: number } = {},
) {
  const events: LiveEvent[] = [];
  const controllers: StandInController[] = [];
  const session = {
    settings: Settings.isolated(options.overrides ?? {}),
  } as unknown as AgentSession;
  const live = new LiveVoice(
    session,
    (event) => events.push(event),
    (controllerOptions) => {
      const controller = new StandInController(controllerOptions, options.startFailure);
      controllers.push(controller);
      return controller;
    },
    options.levelsMs ?? 40,
  );
  const callbacks = () => {
    const controller = controllers.at(-1);
    if (!controller) throw new Error("no live session was started");
    return controller.options.callbacks;
  };
  return { live, events, controllers, callbacks };
}

describe("live voice on the chat host", () => {
  test("the voice is the one asked for, else omp's live.voice setting, else omp's default", async () => {
    const asked = bridge({ overrides: { "live.voice": "ember" } });
    expect(await asked.live.start({ voice: " cove " })).toEqual({ voice: "cove" });
    expect(asked.controllers[0]?.options.voice).toBe("cove");

    const setting = bridge({ overrides: { "live.voice": "ember" } });
    expect(await setting.live.start({})).toEqual({ voice: "ember" });

    const fallback = bridge();
    expect(await fallback.live.start({})).toEqual({ voice: "sol" });
  });

  test("one session at a time: a second start is refused, and a stopped session frees the slot", async () => {
    const { live, controllers } = bridge();
    await live.start({});
    await expect(live.start({})).rejects.toThrow("A live session is already active");
    await live.stop();
    expect(controllers[0]?.stops).toBe(1);
    await live.start({});
    expect(controllers).toHaveLength(2);
  });

  test("a start that fails stops its controller, answers with the failure, and frees the slot", async () => {
    const { live, controllers } = bridge({ startFailure: new Error("no ChatGPT sign-in") });
    await expect(live.start({})).rejects.toThrow("no ChatGPT sign-in");
    expect(controllers[0]?.stops).toBe(1);
    await expect(live.start({})).rejects.toThrow("no ChatGPT sign-in");
    expect(controllers).toHaveLength(2);
  });

  test("levels come at most once per interval, with the latest values", async () => {
    const { live, events, callbacks } = bridge({ levelsMs: 40 });
    await live.start({});
    const { onLevels } = callbacks();
    onLevels(0.1, 0.2);
    onLevels(0.3, 0.4);
    onLevels(0.5, 0.6);
    expect(events).toEqual([{ type: "live_levels", input: 0.1, output: 0.2 }]);
    await Bun.sleep(250);
    expect(events).toEqual([
      { type: "live_levels", input: 0.1, output: 0.2 },
      { type: "live_levels", input: 0.5, output: 0.6 },
    ]);
  });

  test("levels still waiting go out before the end, and none come after it", async () => {
    const { live, events, callbacks } = bridge({ levelsMs: 40 });
    await live.start({});
    const { onLevels, onTerminal } = callbacks();
    onLevels(0.1, 0.2);
    onLevels(0.3, 0.4);
    onTerminal();
    onLevels(0.5, 0.6);
    // omp's controller can still report a level after its end was handled.
    await Bun.sleep(50);
    onLevels(0.7, 0.8);
    await Bun.sleep(250);
    expect(events).toEqual([
      { type: "live_levels", input: 0.1, output: 0.2 },
      { type: "live_levels", input: 0.3, output: 0.4 },
      { type: "live_end" },
    ]);
  });

  test("a session that fails ends once, with its error, and frees the slot", async () => {
    const { live, events, callbacks, controllers } = bridge();
    await live.start({});
    const { onTerminal, onTranscript } = callbacks();
    onTranscript(undefined);
    onTerminal(new Error("the realtime socket closed"));
    onTerminal(new Error("a second report"));
    expect(events).toEqual([{ type: "live_end", error: "the realtime socket closed" }]);
    await live.stop();
    await live.start({});
    expect(controllers).toHaveLength(2);
  });

  test("mute is set, kept, or toggled, and refused without a session", async () => {
    const { live } = bridge();
    expect(() => live.setMuted(true)).toThrow("No live session is active");
    await live.start({});
    expect(live.setMuted(true)).toEqual({ muted: true });
    expect(live.setMuted(true)).toEqual({ muted: true });
    expect(live.setMuted(undefined)).toEqual({ muted: false });
    await live.stop();
    expect(() => live.setMuted(undefined)).toThrow("No live session is active");
  });
});
