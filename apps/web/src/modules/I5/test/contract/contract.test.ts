import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  asVoiceFailure,
  browserSpeechAvailability,
  finalizeVoiceTranscript,
  I5_BROWSER_SPEECH_CAPABILITIES,
  I5_LIVE_CAPABILITY,
  LiveMuteArgsSchema,
  LivePhaseSchema,
  LiveStartArgsSchema,
  LiveStateSchema,
  LiveTranscriptSchema,
  liveCapabilityAvailable,
  unavailableVoice,
} from "../../contract";

describe("I5 voice and dictation contracts", () => {
  test("validates the released live command and phase/transcript schemas", () => {
    expect(LiveStartArgsSchema.parse({ voice: "test-voice", instructions: "be concise" })).toEqual({
      voice: "test-voice",
      instructions: "be concise",
    });
    expect(LiveMuteArgsSchema.parse({ muted: true })).toEqual({ muted: true });
    expect(LivePhaseSchema.parse("listening")).toBe("listening");
    expect(
      LiveTranscriptSchema.parse({
        sessionId: "live-1",
        role: "user",
        turn: 0,
        text: "hello",
        final: false,
      }),
    ).toMatchObject({ role: "user", final: false });
  });

  test("validates live state and finalized transcript handoff identity", () => {
    const state = LiveStateSchema.parse({
      sessionId: "live-1",
      voice: "voice-a",
      phase: "speaking",
      muted: false,
      levels: { input: 0.2, output: 0.7 },
      transcripts: [],
      error: null,
      connected: true,
    });
    expect(state.levels.output).toBe(0.7);
    expect(
      finalizeVoiceTranscript({
        sessionId: "live-1",
        role: "user",
        turn: 2,
        text: "interim",
        final: false,
      }),
    ).toBeNull();
    expect(
      finalizeVoiceTranscript({
        sessionId: "live-1",
        role: "user",
        turn: 2,
        text: "final",
        final: true,
      }),
    ).toMatchObject({
      id: "voice:live-1:user:2",
      role: "user",
      metadata: { modality: "voice", custom: { voiceTurn: 2 } },
    });
  });

  test("gates live RPC and browser speech capabilities without claiming audio transport", () => {
    expect(liveCapabilityAvailable({})).toBe(false);
    expect(
      liveCapabilityAvailable({
        [I5_LIVE_CAPABILITY]: { state: "available", via: "rpc" } as const,
      }),
    ).toBe(true);
    expect(I5_BROWSER_SPEECH_CAPABILITIES.recognition).toBe("client.speech-recognition");
    expect(browserSpeechAvailability()).toHaveProperty("synthesis");
    expect(unavailableVoice(I5_LIVE_CAPABILITY, "live voice is unavailable").appError.code).toBe(
      "unavailable",
    );
  });

  test("keeps AppFailure typed and maps unknown failures without private data", () => {
    const original = new AppFailure({ code: "permission", message: "denied", retryable: false });
    expect(asVoiceFailure(original)).toBe(original);
    expect(asVoiceFailure(new Error("private transcript"), "voice failed").appError.message).toBe(
      "voice failed",
    );
  });
});
