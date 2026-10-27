/**
 * Live voice on the chat host (SDK plan H5.2g4): omp's realtime voice session bound to the chat's session, so the work
 * it hands over runs with the chat's tools, with its callbacks sent as `live_*` events. Rebuilt from omp's RPC live
 * bridge (18.12.6 `modes/rpc/rpc-live.ts`) on omp's `LiveSessionController`.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  LiveSessionController,
  type LiveSessionControllerOptions,
} from "@oh-my-pi/pi-coding-agent/live/controller";
import { cfgLiveVoice } from "@oh-my-pi/pi-coding-agent/live/settings";
import { DEFAULT_LIVE_VOICE } from "@oh-my-pi/pi-coding-agent/live/voices";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveEvent, LiveStartParams } from "@omp-app/contracts/chat-host";

/** The least time between two `live_levels` events (omp's `RPC_LIVE_LEVELS_INTERVAL_MS`). */
export const LIVE_LEVELS_INTERVAL_MS = 100;

/** What the host drives of omp's controller; the units put a stand-in here. */
export type LiveController = Pick<LiveSessionController, "start" | "stop" | "toggleMute" | "muted">;
export type LiveControllerFactory = (options: LiveSessionControllerOptions) => LiveController;

/** An assistant message's visible text: its text blocks only, no thinking or tool calls (omp's rule). */
function visibleText(message: AssistantMessage): string {
  let text = "";
  for (const content of message.content) {
    if (content.type === "text") text += content.text;
  }
  return text.trim();
}

/** At most one live session for the chat. */
export class LiveVoice {
  readonly #session: AgentSession;
  readonly #emit: (event: LiveEvent) => void;
  readonly #createController: LiveControllerFactory;
  readonly #levelsIntervalMs: number;
  /** Set from the start until the controller has fully stopped (connecting, live, closing). */
  #controller: LiveController | undefined;
  #closing: Promise<void> | undefined;
  #pendingLevels: { readonly input: number; readonly output: number } | undefined;
  #levelsTimer: ReturnType<typeof setTimeout> | undefined;
  #lastLevelsAt = Number.NEGATIVE_INFINITY;

  constructor(
    session: AgentSession,
    emit: (event: LiveEvent) => void,
    createController: LiveControllerFactory = (options) => new LiveSessionController(options),
    levelsIntervalMs = LIVE_LEVELS_INTERVAL_MS,
  ) {
    this.#session = session;
    this.#emit = emit;
    this.#createController = createController;
    this.#levelsIntervalMs = levelsIntervalMs;
  }

  /** Connects a live session; resolves once it records. */
  async start(params: LiveStartParams): Promise<{ voice: string }> {
    if (this.#controller) throw new Error("A live session is already active");
    const voice =
      params.voice?.trim() || cfgLiveVoice.get(this.#session.settings) || DEFAULT_LIVE_VOICE;
    let ended = false;
    const controller = this.#createController({
      session: this.#session,
      extractAssistantText: visibleText,
      voice,
      instructions: params.instructions,
      callbacks: {
        onPhase: (phase) => this.#emit({ type: "live_phase", phase }),
        onLevels: (input, output) => {
          if (!ended) this.#queueLevels(input, output);
        },
        onTranscript: (transcript) => {
          if (!transcript) return;
          const { role, turn, text, final } = transcript;
          this.#emit({ type: "live_transcript", role, turn, text, final });
        },
        onTerminal: (error) => {
          if (ended) return;
          ended = true;
          this.#flushLevels();
          this.#emit(error ? { type: "live_end", error: error.message } : { type: "live_end" });
          void this.#retire(controller);
        },
      },
    });
    this.#controller = controller;
    try {
      await controller.start();
    } catch (cause) {
      await this.#retire(controller);
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
    return { voice };
  }

  /** Stops the live session; resolves once it has stopped. Nothing without one. */
  async stop(): Promise<void> {
    const controller = this.#controller;
    if (controller) await this.#retire(controller);
  }

  /** Sets the microphone mute, or toggles it when `muted` is absent. */
  setMuted(muted: boolean | undefined): { muted: boolean } {
    const controller = this.#controller;
    if (!controller || this.#closing) throw new Error("No live session is active");
    if (muted === undefined || muted !== controller.muted) controller.toggleMute();
    return { muted: controller.muted };
  }

  /** Stops `controller` and frees the slot once it has fully stopped; once per controller. */
  #retire(controller: LiveController): Promise<void> {
    if (this.#controller !== controller) return Promise.resolve();
    this.#closing ??= controller.stop().finally(() => {
      if (this.#controller !== controller) return;
      this.#controller = undefined;
      this.#closing = undefined;
      // No levels follow `live_end`.
      clearTimeout(this.#levelsTimer);
      this.#levelsTimer = undefined;
      this.#pendingLevels = undefined;
    });
    return this.#closing;
  }

  #queueLevels(input: number, output: number): void {
    this.#pendingLevels = { input, output };
    if (this.#levelsTimer) return;
    const wait = this.#lastLevelsAt + this.#levelsIntervalMs - Date.now();
    if (wait <= 0) {
      this.#flushLevels();
      return;
    }
    this.#levelsTimer = setTimeout(() => {
      this.#levelsTimer = undefined;
      this.#flushLevels();
    }, wait);
  }

  #flushLevels(): void {
    clearTimeout(this.#levelsTimer);
    this.#levelsTimer = undefined;
    const levels = this.#pendingLevels;
    if (!levels) return;
    this.#pendingLevels = undefined;
    this.#lastLevelsAt = Date.now();
    this.#emit({ type: "live_levels", input: levels.input, output: levels.output });
  }
}
