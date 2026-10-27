import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1280: the live voice control above the composer, and the live status and transcript above it.
 *
 * - Test 1 sends one real `live_start`. omp opens the default speaker before it checks the Codex sign-in
 *   (`crates/pi-voice/src/live.rs:150`, called from `transport.ts:170`; the sign-in check is `transport.ts:172`
 *   and `transport.ts:184-193`). So test 1 is skipped wherever a sound device or sound server exists. On the test machine's
 *   container there is none, and omp's refusal is the real process's answer.
 * - The other tests never reach omp's live commands. The route answers them with the results from omp's RPC docs
 *   (`docs/rpc.md`, Live Voice Sub-Protocol) and puts the documented live frames on the app's event stream. No voice
 *   session runs, so those frames are the documented shapes, not a recorded session.
 */

interface LiveControl {
  /** Set once the app's socket is open and the frames can be put on its event stream. */
  ready: boolean;
  /** The live commands the app sent, in order. */
  readonly commands: string[];
  /** Puts one notification frame on the app's event stream, at the next sequence number. */
  inject(frame: Record<string, unknown>): void;
  /** Answer the live commands with the docs' results instead of letting omp refuse them. */
  answerLive: boolean;
  /** omp's `live_end` frame once it has passed through the route: the failure it carries, if any. */
  liveEnd: { error?: string } | undefined;
}

function newLiveControl(): LiveControl {
  return {
    ready: false,
    commands: [],
    inject() {
      throw new Error("the app's socket is not open yet");
    },
    answerLive: false,
    liveEnd: undefined,
  };
}

function frameOf(message: string | Buffer): Record<string, unknown> {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The docs' results: `live_start` answers `{ voice }`, `live_mute` answers `{ muted }`, and `live_stop` answers null, which
 * is what the app's server sends for a command with no data (the app rejects a result frame with no value at all).
 */
function docsResult(command: {
  type: string;
  muted?: boolean;
}): { readonly value?: unknown } | undefined {
  if (command.type === "live_start") return { value: { voice: "sol" } };
  if (command.type === "live_mute") return { value: { muted: command.muted === true } };
  if (command.type === "live_stop") return { value: null };
  return undefined;
}

/**
 * Whether this machine has a sound device or a sound server. Real omp opens the default speaker when `live_start`
 * begins, so a real start may open audio here. Any sign of sound skips that test.
 */
function hasAudioBackend(): boolean {
  if (process.env.PULSE_SERVER !== undefined) return true;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`;
  return [
    "/dev/snd",
    "/run/pulse",
    join(runtime, "pulse"),
    join(runtime, "pipewire-0"),
    "/usr/lib/x86_64-linux-gnu/libpulse-simple.so.0",
    "/usr/lib/libpulse-simple.so.0",
    "/lib/x86_64-linux-gnu/libpulse-simple.so.0",
  ].some((path) => existsSync(path));
}

/** Routes the app's socket: records the live commands, answers them when asked, and injects frames on the event stream. */
function liveOmp(control: LiveControl) {
  return async (page: Page): Promise<void> => {
    await page.routeWebSocket(
      () => true,
      (webSocket) => {
        const server = webSocket.connectToServer();
        // The app's event stream is one sequence: the server's events, with the frames the route injects numbered in
        // between (each injected frame takes the next number, and the server's later events come after them).
        let serverSeq = 0;
        let injected = 0;
        let eventStream: string | undefined;
        webSocket.onMessage((message) => {
          const frame = frameOf(message);
          if (frame.type === "subscribe" && typeof frame.stream === "string") {
            if (frame.stream.startsWith("A0.chatSession/event/")) eventStream = frame.stream;
          }
          if (
            frame.type === "call" &&
            frame.port === "A0.chatSession" &&
            frame.method === "request"
          ) {
            const args = frame.args as { method?: string; params?: { muted?: boolean } };
            if (args.method?.startsWith("live_")) {
              control.commands.push(args.method);
              const command = { type: args.method, muted: args.params?.muted };
              const answer = control.answerLive ? docsResult(command) : undefined;
              if (answer !== undefined) {
                webSocket.send(
                  JSON.stringify({ type: "result", id: frame.id, ok: true, value: answer.value }),
                );
                return;
              }
            }
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = frameOf(message);
          const payload = frame.payload as
            | { kind?: string; event?: { type?: string; error?: string } }
            | undefined;
          if (
            frame.type === "event" &&
            payload?.kind === "event" &&
            payload.event?.type === "live_end"
          ) {
            control.liveEnd = { error: payload.event.error };
          }
          if (
            frame.type === "event" &&
            frame.stream === eventStream &&
            typeof frame.seq === "number"
          ) {
            serverSeq = frame.seq;
            void webSocket.send(JSON.stringify({ ...frame, seq: frame.seq + injected }));
            return;
          }
          void webSocket.send(message);
        });
        control.ready = true;
        control.inject = (notification) => {
          if (eventStream === undefined)
            throw new Error("the app has not subscribed to the event stream yet");
          const seq = serverSeq + injected + 1;
          injected += 1;
          void webSocket.send(
            JSON.stringify({
              type: "event",
              stream: eventStream,
              seq,
              payload: { kind: "event", event: notification },
            }),
          );
        };
      },
    );
  };
}

/** The live control's icon buttons, named by what they do. */
function liveButton(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

/** The visible words of the live status panel: the phase, shown only while live, connecting or after an error. */
function liveStatus(page: Page): Locator {
  return page.getByTestId("live-status");
}

realTest(
  "live voice: omp refuses the start here, its error shows above the composer, and the app's live_start is recorded",
  async ({ realApp }, testInfo) => {
    realTest.skip(
      hasAudioBackend(),
      "This machine has a sound device or sound server: omp would open the speaker before it checks the sign-in.",
    );
    testInfo.setTimeout(240_000);
    const control = newLiveControl();
    const page = await realApp.open({ beforeLoad: liveOmp(control) });
    await startChat(page);
    await expect.poll(() => control.ready).toBe(true);

    await liveButton(page, "Start live voice").click();

    // omp refuses with its own error and sends live_end with it; the alert shows exactly that text.
    await expect.poll(() => control.liveEnd?.error, { timeout: 60_000 }).toBeTruthy();
    const omp = control.liveEnd?.error ?? "";
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText(omp);
    await expect(liveStatus(page)).toHaveText("Stopped with an error");
    await expect(page.getByRole("status").filter({ hasText: "Stopped with an error" })).toHaveCount(
      1,
    );
    await expect(liveButton(page, "Start live voice")).toBeEnabled();
    expect(control.commands).toEqual(["live_stop", "live_start"]);
    expect(realApp.problems).toEqual([]);
  },
);

async function runLiveSession(page: Page, control: LiveControl): Promise<void> {
  const composer = await startChat(page);
  await expect.poll(() => control.ready).toBe(true);
  await liveButton(page, "Start live voice").click();
  await expect.poll(() => control.commands).toEqual(["live_stop", "live_start"]);

  // omp's phase frames, in the order the docs give them: connecting, then listening once the session records.
  control.inject({ type: "live_phase", phase: "connecting" });
  control.inject({ type: "live_phase", phase: "listening" });
  await expect(liveStatus(page)).toHaveText("Listening");

  // Levels: the app keeps at most one update per 100 ms, so the meter reaches the latest value.
  control.inject({ type: "live_levels", input: 0.4, output: 0.7 });
  await expect(page.getByRole("meter", { name: "Microphone level" })).toHaveAttribute(
    "value",
    "0.4",
  );
  await expect(page.getByRole("meter", { name: "Speaker level" })).toHaveAttribute("value", "0.7");

  // The user's words, as they arrive, then final; the final line becomes a chat message and leaves the panel.
  control.inject({ type: "live_transcript", role: "user", turn: 0, text: "hel", final: false });
  await expect(page.getByLabel("Live transcript")).toContainText("You: hel");
  control.inject({
    type: "live_transcript",
    role: "user",
    turn: 0,
    text: "hello omp",
    final: true,
  });
  await expect(page.getByLabel("Live transcript")).toHaveCount(0);
  await expect(page.getByText("hello omp", { exact: true })).toBeVisible();

  control.inject({
    type: "live_transcript",
    role: "assistant",
    turn: 1,
    text: "Hi, I can hear you.",
    final: true,
  });
  await expect(page.getByText("Hi, I can hear you.", { exact: true })).toBeVisible();

  // Mute, then unmute with the same control; omp answers with the new state.
  await liveButton(page, "Mute microphone").click();
  await expect.poll(() => control.commands.at(-1)).toBe("live_mute");
  await expect(liveStatus(page)).toHaveText("Microphone muted");
  await expect(liveButton(page, "Unmute microphone")).toBeVisible();
  await liveButton(page, "Unmute microphone").click();
  await expect(liveButton(page, "Mute microphone")).toBeVisible();

  // Stop: the app sends live_stop; omp ends the session with one live_end.
  await liveButton(page, "Stop live voice").click();
  await expect.poll(() => control.commands.at(-1)).toBe("live_stop");
  control.inject({ type: "live_end" });
  await expect(page.getByRole("status").filter({ hasText: "Ended" })).toHaveCount(1);
  await expect(liveButton(page, "Start live voice")).toBeEnabled();

  // A normal prompt after the voice turn: its settled history must not move the voice lines behind it.
  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  await sendPrompt(composer, "after voice");
  await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 90_000 });
  const voice = await transcript.getByText("hello omp", { exact: true }).boundingBox();
  const prompt = await transcript.getByText("after voice", { exact: true }).boundingBox();
  if (voice === null || prompt === null)
    throw new Error("the voice line or the prompt is not on screen");
  expect(voice.y).toBeLessThan(prompt.y);
  await expect(transcript.getByText("Hi, I can hear you.", { exact: true })).toBeVisible();
}

realTest(
  "live voice: start, levels, a live transcript that turns into chat messages, mute and stop, then a normal prompt, driven with omp's documented frames",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const control = newLiveControl();
    control.answerLive = true;
    const page = await realApp.open({ beforeLoad: liveOmp(control) });
    await page.setViewportSize({ width: 1280, height: 900 });
    await runLiveSession(page, control);
    // Leaving a chat while live ends its session in omp: the app sends live_stop when the chat is left.
    await liveButton(page, "Start live voice").click();
    await expect.poll(() => control.commands.at(-1)).toBe("live_start");
    control.inject({ type: "live_phase", phase: "listening" });
    await expect(liveStatus(page)).toHaveText("Listening");
    await startChat(page);
    await expect.poll(() => control.commands.at(-1)).toBe("live_stop");
    expect(control.commands).toEqual([
      "live_stop",
      "live_start",
      "live_mute",
      "live_mute",
      "live_stop",
      "live_stop",
      "live_start",
      "live_stop",
    ]);
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Captures the control at each width, idle and live. The chat starts on the desktop layout, where its New chat
 * button is in the sessions list, and the width changes after that.
 */
for (const [width, height, theme] of [
  [320, 700, "light"],
  [320, 700, "dark"],
  [390, 844, "light"],
  [390, 844, "dark"],
  [834, 1112, "light"],
  [834, 1112, "dark"],
  [1280, 900, "light"],
  [1280, 900, "dark"],
] as const) {
  realTest(
    `live voice: the control and status at ${width} px, ${theme} theme`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      await mkdir(screenshots, { recursive: true });
      const control = newLiveControl();
      control.answerLive = true;
      const route = liveOmp(control);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.addInitScript(
            (value) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          );
          await route(target);
        },
      });
      await startChat(page);
      await page.setViewportSize({ width, height });
      await expect.poll(() => control.ready).toBe(true);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, `live-voice-idle-${width}-${theme}.png`) });

      await liveButton(page, "Start live voice").click();
      await expect.poll(() => control.commands).toEqual(["live_stop", "live_start"]);
      control.inject({ type: "live_phase", phase: "listening" });
      control.inject({ type: "live_levels", input: 0.4, output: 0.7 });
      control.inject({
        type: "live_transcript",
        role: "user",
        turn: 0,
        text: "Can you hear me",
        final: false,
      });
      await expect(page.getByLabel("Live transcript")).toContainText("Can you hear me");
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, `live-voice-live-${width}-${theme}.png`) });
    },
  );
}
