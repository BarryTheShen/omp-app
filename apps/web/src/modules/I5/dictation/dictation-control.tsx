import { useAui, useAuiState } from "@assistant-ui/react";
import { Mic, MicOff } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { BrowserDictationPort } from "./adapter";

export type DictationMode = "push-to-talk" | "toggle";

export interface DictationControlProps {
  readonly mode: DictationMode;
  readonly adapter: BrowserDictationPort;
  readonly unavailableReason?: string;
  readonly disabled?: boolean;
  readonly onError?: (message: string) => void;
}

const DEFAULT_UNAVAILABLE_REASON = "Speech recognition is not available in this browser.";

/** A safe U2 toolbar control: dictation edits the composer but never submits it. */
function DictationControl({
  mode,
  adapter,
  unavailableReason = adapter.unavailableReason ?? DEFAULT_UNAVAILABLE_REASON,
  disabled = false,
  onError,
}: DictationControlProps) {
  const aui = useAui();
  const dictation = useAuiState((state) => state.composer.dictation);
  const composerText = useAuiState((state) => state.composer.text);
  const available = adapter.available;
  const [failure, setFailure] = useState<string | undefined>();
  const [held, setHeld] = useState(false);
  const [ownsSession, setOwnsSession] = useState(false);
  const pressed = useRef(false);
  const pressSource = useRef<"pointer" | "keyboard" | undefined>(undefined);
  const pointerId = useRef<number | undefined>(undefined);
  const originalDraft = useRef<string | undefined>(undefined);
  const finalDraft = useRef<string | undefined>(undefined);
  const ownsSessionRef = useRef(false);
  const sessionSeenRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const stopRef = useRef(aui.composer.stopDictation);
  stopRef.current = aui.composer.stopDictation;
  const setSessionOwnership = useCallback((owned: boolean): void => {
    ownsSessionRef.current = owned;
    setOwnsSession(owned);
  }, []);
  const isDisabled = disabled || !available;
  const sessionStatus = dictation?.status.type;
  const active = ownsSession && sessionStatus === "running";
  const starting = ownsSession && sessionStatus === "starting";
  useEffect(() => {
    if (dictation !== undefined) {
      sessionSeenRef.current = true;
      return;
    }
    if (sessionSeenRef.current) {
      sessionSeenRef.current = false;
      setSessionOwnership(false);
    }
  }, [dictation, setSessionOwnership]);
  const reportFailure = useCallback((message: string): void => {
    setFailure(message);
    onErrorRef.current?.(message);
  }, []);

  useEffect(
    () =>
      adapter.subscribeError((message) => {
        if (!ownsSessionRef.current) return;
        const draft = finalDraft.current ?? originalDraft.current;
        if (draft !== undefined) aui.composer.setText(draft);
        originalDraft.current = undefined;
        finalDraft.current = undefined;
        setSessionOwnership(false);
        reportFailure(message);
      }),
    [adapter, aui, reportFailure, setSessionOwnership],
  );

  useEffect(() => {
    if (!active) {
      originalDraft.current = undefined;
      finalDraft.current = undefined;
      return;
    }
    const interim = dictation?.transcript;
    finalDraft.current =
      interim !== undefined && composerText.endsWith(interim)
        ? composerText.slice(0, -interim.length).trimEnd()
        : composerText;
  }, [active, composerText, dictation?.transcript]);
  const start = useCallback((): boolean => {
    if (isDisabled) return false;
    setSessionOwnership(true);
    originalDraft.current = composerText;
    finalDraft.current = composerText;
    try {
      aui.composer.startDictation();
      setFailure(undefined);
      return true;
    } catch {
      setSessionOwnership(false);
      originalDraft.current = undefined;
      finalDraft.current = undefined;
      reportFailure("Dictation could not start.");
      return false;
    }
  }, [aui, composerText, isDisabled, reportFailure, setSessionOwnership]);

  const stop = useCallback((): void => {
    try {
      aui.composer.stopDictation();
      sessionSeenRef.current = false;
      setSessionOwnership(false);
    } catch {
      reportFailure("Dictation could not stop.");
    }
  }, [aui, reportFailure, setSessionOwnership]);

  const beginPushToTalk = useCallback(
    (source: "pointer" | "keyboard", activePointerId?: number): void => {
      if (pressed.current || isDisabled) return;
      if (!start()) return;
      pressed.current = true;
      pressSource.current = source;
      pointerId.current = source === "pointer" ? activePointerId : undefined;
      setHeld(true);
    },
    [isDisabled, start],
  );

  const endPushToTalk = useCallback(
    (source?: "pointer" | "keyboard", activePointerId?: number): void => {
      if (!pressed.current) return;
      if (source !== undefined && pressSource.current !== source) return;
      if (
        source === "pointer" &&
        activePointerId !== undefined &&
        pointerId.current !== activePointerId
      ) {
        return;
      }
      pressed.current = false;
      pressSource.current = undefined;
      pointerId.current = undefined;
      setHeld(false);
      stop();
    },
    [stop],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      beginPushToTalk("pointer", event.pointerId);
    },
    [beginPushToTalk],
  );
  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void =>
      endPushToTalk("pointer", event.pointerId),
    [endPushToTalk],
  );

  useEffect(() => {
    if (active || !pressed.current) return;
    pressed.current = false;
    pressSource.current = undefined;
    pointerId.current = undefined;
    setHeld(false);
  }, [active]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (
        (event.key !== " " && event.key !== "Enter") ||
        event.repeat ||
        event.nativeEvent.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      beginPushToTalk("keyboard");
    },
    [beginPushToTalk],
  );

  const handleKeyUp = useCallback(
    (event: { readonly key: string; preventDefault: () => void }): void => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      endPushToTalk("keyboard");
    },
    [endPushToTalk],
  );

  useEffect(
    () => () => {
      if (!pressed.current) return;
      pressed.current = false;
      pressSource.current = undefined;
      pointerId.current = undefined;
      try {
        stopRef.current();
      } catch {
        onErrorRef.current?.("Dictation could not stop.");
      }
    },
    [],
  );

  if (mode === "toggle") {
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Button
          aria-pressed={active ? "true" : "false"}
          disabled={isDisabled}
          onClick={() => (active ? stop() : start())}
          type="button"
          variant="outline"
        >
          {active ? (
            <MicOff aria-hidden="true" className="size-4" />
          ) : (
            <Mic aria-hidden="true" className="size-4" />
          )}
          {starting ? "Starting dictation" : active ? "Stop dictation" : "Start dictation"}
        </Button>
        {!available ? (
          <p
            className="max-w-56 text-xs text-muted-foreground [overflow-wrap:anywhere]"
            role="status"
          >
            {unavailableReason}
          </p>
        ) : failure !== undefined ? (
          <p className="max-w-56 text-xs text-destructive [overflow-wrap:anywhere]" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        aria-label={
          available
            ? starting
              ? "Starting dictation"
              : "Hold to dictate"
            : "Dictation unavailable"
        }
        aria-pressed={active && held ? "true" : "false"}
        disabled={isDisabled}
        onBlur={() => endPushToTalk()}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onLostPointerCapture={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerUp={handlePointerEnd}
        type="button"
        variant="outline"
      >
        {active && held ? (
          <MicOff aria-hidden="true" className="size-4" />
        ) : (
          <Mic aria-hidden="true" className="size-4" />
        )}
        {starting ? "Starting dictation" : active && held ? "Listening" : "Hold to dictate"}
      </Button>
      {!available ? (
        <p
          className="max-w-56 text-xs text-muted-foreground [overflow-wrap:anywhere]"
          role="status"
        >
          {unavailableReason}
        </p>
      ) : failure !== undefined ? (
        <p className="max-w-56 text-xs text-destructive [overflow-wrap:anywhere]" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export const dictationViews = { control: DictationControl } as const;
