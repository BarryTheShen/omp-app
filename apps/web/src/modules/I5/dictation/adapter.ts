import type { DictationAdapter } from "@assistant-ui/react";
import type { CapabilityKey } from "@omp-app/contracts";
import type { DictationPort } from "../contract";
import { I5_BROWSER_SPEECH_CAPABILITIES, unavailableVoice } from "../contract";

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

export interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionAlternativeLike> {
  readonly isFinal: boolean;
}

export interface SpeechRecognitionResultEventLike extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error?: string;
}

/** The subset of Web Speech recognition used by assistant-ui's dictation session. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

export interface BrowserDictationPort extends DictationPort {
  subscribeError(listener: (message: string) => void): () => void;
}

export interface BrowserDictationOptions {
  /** Set for tests or a host-provided Web Speech implementation. Omit to feature-detect the browser. */
  readonly recognition?: SpeechRecognitionConstructor | null;
  readonly language?: string;
  readonly continuous?: boolean;
  readonly interimResults?: boolean;
  /** Receives only fixed, user-safe failure text; browser error details are never forwarded. */
  readonly onError?: (message: string) => void;
}

const UNAVAILABLE_REASON = "Speech recognition is not available in this browser.";
const START_FAILURE = "Dictation could not start.";
const STOP_FAILURE = "Dictation could not stop.";
const STOP_TIMEOUT_MS = 5_000;

function browserRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const scope = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied.";
    case "audio-capture":
      return "A microphone is not available.";
    case "no-speech":
      return "No speech was detected.";
    case "network":
      return "The speech service could not be reached.";
    case "language-not-supported":
      return "This language is not supported for dictation.";
    default:
      return "Dictation ended unexpectedly.";
  }
}

/** Creates the browser recognition adapter used by assistant-ui's DictationAdapter contract. */
export function createBrowserDictationPort(
  options: BrowserDictationOptions = {},
): BrowserDictationPort {
  const Recognition =
    options.recognition === undefined ? browserRecognitionConstructor() : options.recognition;
  const available = Recognition !== undefined && Recognition !== null;
  const unavailableReason = available ? undefined : UNAVAILABLE_REASON;
  const capability: CapabilityKey = I5_BROWSER_SPEECH_CAPABILITIES.recognition;
  const errorListeners = new Set<(message: string) => void>();
  const reportError = (message: string): void => {
    options.onError?.(message);
    for (const listener of [...errorListeners]) listener(message);
  };

  return {
    available,
    disableInputDuringDictation: true,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    subscribeError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    listen(): DictationAdapter.Session {
      if (Recognition === undefined || Recognition === null) {
        throw unavailableVoice(capability, UNAVAILABLE_REASON);
      }

      const recognition = new Recognition();
      if (options.language !== undefined) recognition.lang = options.language;
      recognition.continuous = options.continuous ?? true;
      recognition.interimResults = options.interimResults ?? true;

      let status: DictationAdapter.Session["status"] = { type: "starting" };
      let ended = false;
      let finalTranscript = "";
      let stopPromise: Promise<void> | undefined;
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      let resolveStop: (() => void) | undefined;
      const speechStartListeners = new Set<() => void>();
      const speechEndListeners = new Set<(result: DictationAdapter.Result) => void>();
      const speechListeners = new Set<(result: DictationAdapter.Result) => void>();

      const finish = (reason: "stopped" | "cancelled" | "error"): void => {
        if (ended) return;
        ended = true;
        if (stopTimeout !== undefined) {
          clearTimeout(stopTimeout);
          stopTimeout = undefined;
        }
        status = { type: "ended", reason };
        for (const listener of [...speechEndListeners]) {
          listener({ transcript: finalTranscript, isFinal: true });
        }
        resolveStop?.();
        resolveStop = undefined;
      };

      recognition.onstart = () => {
        if (ended) return;
        status = { type: "running" };
        for (const listener of [...speechStartListeners]) listener();
      };
      recognition.onresult = (event) => {
        if (ended) return;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (transcript.length === 0) continue;
          if (result?.isFinal) finalTranscript += transcript;
          const speech = { transcript, isFinal: result?.isFinal ?? false };
          for (const listener of [...speechListeners]) listener(speech);
        }
      };
      recognition.onerror = (event) => {
        if (ended) return;
        reportError(errorMessage(event.error));
        finish("error");
      };
      recognition.onend = () => finish("stopped");

      const session: DictationAdapter.Session = {
        get status() {
          return status;
        },
        stop: () => {
          if (ended) return Promise.resolve();
          stopPromise ??= new Promise<void>((resolve) => {
            resolveStop = resolve;
          });
          try {
            recognition.stop();
          } catch {
            reportError(STOP_FAILURE);
            finish("error");
          }
          if (!ended && stopTimeout === undefined) {
            stopTimeout = setTimeout(() => {
              if (ended) return;
              reportError(STOP_FAILURE);
              finish("error");
              try {
                recognition.abort();
              } catch {
                // The session is already finished; there is nothing else to recover.
              }
            }, STOP_TIMEOUT_MS);
          }
          return stopPromise;
        },
        cancel: () => {
          finish("cancelled");
          try {
            recognition.abort();
          } catch {
            reportError(STOP_FAILURE);
          }
        },
        onSpeechStart: (callback) => {
          speechStartListeners.add(callback);
          return () => speechStartListeners.delete(callback);
        },
        onSpeechEnd: (callback) => {
          speechEndListeners.add(callback);
          if (ended) callback({ transcript: finalTranscript, isFinal: true });
          return () => speechEndListeners.delete(callback);
        },
        onSpeech: (callback) => {
          speechListeners.add(callback);
          return () => speechListeners.delete(callback);
        },
      };

      try {
        recognition.start();
      } catch {
        reportError(START_FAILURE);
        finish("error");
        throw unavailableVoice(capability, START_FAILURE);
      }
      return session;
    },
  };
}
