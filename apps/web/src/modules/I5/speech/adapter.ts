import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import type { SpeechAdapter } from "../contract";

const UNAVAILABLE_REASON = "Speech playback is not available in this browser.";

export interface BrowserSpeechOptions {
  /** Set for tests or a host-provided implementation. Omit to feature-detect the browser. */
  readonly synthesis?: Pick<SpeechSynthesis, "speak" | "cancel"> | null;
  readonly createUtterance?: (text: string) => SpeechSynthesisUtterance;
  /** Receives fixed user-safe failure text, never a browser error object's details. */
  readonly onError?: (message: string) => void;
}

function browserSynthesis(): Pick<SpeechSynthesis, "speak" | "cancel"> | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const scope = globalThis as typeof globalThis & {
    speechSynthesis?: Pick<SpeechSynthesis, "speak" | "cancel">;
  };
  return scope.speechSynthesis;
}

function browserUtteranceFactory(): ((text: string) => SpeechSynthesisUtterance) | undefined {
  if (typeof SpeechSynthesisUtterance === "undefined") return undefined;
  return (text) => new SpeechSynthesisUtterance(text);
}

function settledUtterance(
  reason: "finished" | "cancelled" | "error",
  error?: unknown,
): SpeechSynthesisAdapter.Utterance {
  return {
    status: { type: "ended", reason, ...(error === undefined ? {} : { error }) },
    cancel: () => undefined,
    subscribe: () => () => undefined,
  };
}

/** Creates the browser playback adapter consumed by assistant-ui's speech primitives. */
export function createBrowserSpeechAdapter(options: BrowserSpeechOptions = {}): SpeechAdapter {
  const synthesis = options.synthesis === undefined ? browserSynthesis() : options.synthesis;
  const createUtterance = options.createUtterance ?? browserUtteranceFactory();
  const available = synthesis !== undefined && synthesis !== null && createUtterance !== undefined;

  return {
    available,
    ...(available ? {} : { unavailableReason: UNAVAILABLE_REASON }),
    speak(text: string): SpeechSynthesisAdapter.Utterance {
      if (synthesis === undefined || synthesis === null || createUtterance === undefined) {
        return settledUtterance("error", new Error(UNAVAILABLE_REASON));
      }

      let status: SpeechSynthesisAdapter.Utterance["status"] = { type: "starting" };
      let ended = false;
      let cancelRequested = false;
      const listeners = new Set<() => void>();
      const native = createUtterance(text);
      const publish = (next: SpeechSynthesisAdapter.Utterance["status"]): void => {
        if (ended) return;
        status = next;
        if (next.type === "ended") ended = true;
        for (const listener of [...listeners]) listener();
      };

      native.onstart = () => publish({ type: "running" });
      native.onend = () =>
        publish({ type: "ended", reason: cancelRequested ? "cancelled" : "finished" });
      native.onerror = (event) => {
        const cancelled =
          cancelRequested || event.error === "canceled" || event.error === "interrupted";
        const message = cancelled ? "Speech playback was stopped." : "Speech playback failed.";
        options.onError?.(message);
        publish({
          type: "ended",
          reason: cancelled ? "cancelled" : "error",
          ...(cancelled ? {} : { error: new Error(message) }),
        });
      };

      const utterance: SpeechSynthesisAdapter.Utterance = {
        get status() {
          return status;
        },
        cancel: () => {
          if (ended) return;
          cancelRequested = true;
          try {
            synthesis.cancel();
          } catch {
            options.onError?.("Speech playback could not be stopped.");
          }
          publish({ type: "ended", reason: "cancelled" });
        },
        subscribe: (callback) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      };

      try {
        synthesis.speak(native);
      } catch {
        const message = "Speech playback failed.";
        options.onError?.(message);
        publish({ type: "ended", reason: "error", error: new Error(message) });
      }
      return utterance;
    },
  };
}
