import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import { describe, expect, test, vi } from "vitest";
import { createBrowserSpeechAdapter } from "../../speech";

type FakeUtterance = {
  readonly text: string;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
};

function speechHarness(options: { readonly onError?: (message: string) => void } = {}) {
  const utterances: FakeUtterance[] = [];
  const synthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Pick<SpeechSynthesis, "speak" | "cancel">;
  const adapter = createBrowserSpeechAdapter({
    synthesis,
    createUtterance: (text) => {
      const utterance: FakeUtterance = {
        text,
        onstart: null,
        onend: null,
        onerror: null,
      };
      utterances.push(utterance);
      return utterance as unknown as SpeechSynthesisUtterance;
    },
    onError: options.onError,
  });
  return { adapter, synthesis, utterances };
}

describe("the browser speech adapter", () => {
  test("publishes start, finish and cancellation through assistant-ui's utterance", () => {
    const { adapter, synthesis, utterances } = speechHarness();
    expect(adapter.available).toBe(true);

    const utterance = adapter.speak("Read this answer");
    expect(utterance.status).toEqual({ type: "starting" });
    const native = utterances[0];
    if (!native) throw new Error("The speech utterance was not created.");
    const changed = vi.fn();
    utterance.subscribe(changed);
    native.onstart?.(new Event("start"));
    expect(utterance.status).toEqual({ type: "running" });
    native.onend?.(new Event("end"));
    expect(utterance.status).toEqual({ type: "ended", reason: "finished" });
    expect(changed).toHaveBeenCalledTimes(2);

    const next = adapter.speak("Read another answer");
    next.cancel();
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    expect(next.status).toEqual({ type: "ended", reason: "cancelled" });
  });

  test("reports a safe speech failure and settles the utterance", () => {
    const onError = vi.fn();
    const { adapter, utterances } = speechHarness({ onError });
    expect(adapter.available).toBe(true);
    const utterance = adapter.speak("Read the answer");
    const native = utterances[0];
    if (!native) throw new Error("The speech utterance was not created.");
    native.onerror?.(
      Object.assign(new Event("error"), { error: "network" }) as SpeechSynthesisErrorEvent,
    );
    expect(utterance.status).toMatchObject({ type: "ended", reason: "error" });
    expect(onError).toHaveBeenCalledWith("Speech playback failed.");
  });

  test("provides an explicit unsupported state instead of calling missing browser APIs", () => {
    const adapter = createBrowserSpeechAdapter({ synthesis: null });
    expect(adapter.available).toBe(false);
    expect(adapter.unavailableReason).toBe("Speech playback is not available in this browser.");
    const utterance: SpeechSynthesisAdapter.Utterance = adapter.speak("Anything");
    expect(utterance.status).toMatchObject({ type: "ended", reason: "error" });
  });
});
