import { type AppError, AppFailure } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { InlineError, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { ModeSnapshot, ModeState } from "../contract";
import { type BrowserVisibility, type D73Mode, MODE_LABELS } from "./commands";
import type { ModeControllerPort } from "./controller";
import { usageLimitText } from "./slow";

type ModeErrorKind = "change" | "refresh";

export interface ModeControlsModel {
  readonly snapshot: ModeSnapshot;
  readonly browserVisibility: BrowserVisibility | null;
  readonly busyMode: D73Mode | "browser" | null;
  readonly error: AppError | null;
  /** Which action failed: a failed refresh is not reported as a failed setting change. */
  readonly errorKind?: ModeErrorKind;
  /** The mode whose change failed, so the heading names it; null when no single mode failed. */
  readonly errorMode?: D73Mode | null;
}

export interface ModeControlsActions {
  readonly onRequest: (mode: D73Mode, requested: boolean) => void;
  readonly onBrowserVisibility: (visibility: BrowserVisibility) => void;
  readonly onRefresh: () => void;
  readonly onRetry?: () => void;
}

export interface ModeControlsProps {
  readonly model: ModeControlsModel;
  readonly actions: ModeControlsActions;
}

type ModeStateLike = ModeState | ModeSnapshot["fast"];

function modeState(snapshot: ModeSnapshot, mode: D73Mode): ModeStateLike | undefined {
  return mode === "fast" ? snapshot.fast : snapshot.modes[mode];
}

/** The one status line a mode shows, in plain words. Standard execution shows none. */
function statusText(mode: D73Mode, state: ModeStateLike | undefined): string {
  if (state === undefined) return "Waiting for the chat to connect.";
  switch (state.state) {
    case "known":
      return knownText(mode, state);
    case "requested":
      // Fast and Slow mode have no reply to show: until omp answers, the app is checking with omp.
      if (mode === "fast" || mode === "slow") return "Checking with omp…";
      return state.reason ? `Sent to omp. ${state.reason}` : "Sent to omp.";
    case "fallback":
      return unknownText(mode, state);
    case "unavailable":
      return state.reason ?? "Not available.";
  }
}

/**
 * omp does not report this mode's state. The line says so and what the person can do: a setting they
 * chose in this chat reads as set, and until they choose one, the choice is theirs.
 */
function unknownText(mode: D73Mode, state: ModeStateLike): string {
  if (mode === "fast" || mode === "slow") {
    return `omp has not reported ${MODE_LABELS[mode]} yet. Refresh status to check it.`;
  }
  const chosen = state.requested !== undefined;
  if (mode === "browser") {
    return chosen
      ? "Set for this chat. omp does not say whether its browser window is visible."
      : "omp does not say whether its browser window is visible. Choose Headless or Visible window for this chat.";
  }
  return chosen
    ? "Set for this chat. omp does not report whether it is on."
    : "omp does not report whether this is on. Choose Turn on or Turn off for this chat.";
}

/** On or off as omp reported it; for Fast mode, also whether the current model uses the tier. */
function knownText(mode: D73Mode, state: ModeStateLike): string {
  const onOrOff = !state.enabled
    ? "Off"
    : mode === "fast" && state.active === false
      ? "On, but the current model does not use it"
      : "On";
  // omp's usage-limit stage for the account is shown whether slow mode is on or off.
  if (!("usageLimit" in state) || state.usageLimit === undefined) return onOrOff;
  return `${onOrOff}. ${usageLimitText(state.usageLimit)}`;
}

/**
 * What a Fast mode button shows as chosen: omp's own report once omp has given one, otherwise the change
 * the person asked for that omp has not answered yet. Undefined selects neither button.
 */
function fastChoice(fast: ModeSnapshot["fast"]): boolean | undefined {
  return fast.state === "known" ? fast.enabled : fast.requested;
}

function isDisabled(state: ModeStateLike | undefined, busy: boolean): boolean {
  return busy || state?.state === "unavailable";
}

function ErrorMessage({
  error,
  kind,
  mode,
  onRetry,
}: {
  readonly error: AppError;
  readonly kind: ModeErrorKind;
  /** The mode whose change failed; null when no single mode is named. */
  readonly mode: D73Mode | null;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <InlineError
      heading={
        kind === "refresh"
          ? "The settings could not be loaded"
          : `${mode === null ? "This setting" : MODE_LABELS[mode]} could not be changed.`
      }
      message={error.message}
      onRetry={error.retryable ? onRetry : undefined}
      retryLabel="Try again"
    />
  );
}

function ModeStateText({
  mode,
  state,
  shownError,
}: {
  readonly mode: D73Mode;
  readonly state: ModeStateLike | undefined;
  /** The message the error block already shows; the row does not repeat it. */
  readonly shownError: string | null;
}) {
  // A failed change shows its message once, in the error block above; this row's line stays empty.
  const repeats = shownError !== null && state?.reason === shownError;
  return (
    <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
      {repeats ? "" : statusText(mode, state)}
    </span>
  );
}

function ToggleRow({
  mode,
  title,
  description,
  chosen,
  state,
  busy,
  onRequest,
  shownError,
}: {
  readonly mode: D73Mode;
  readonly title: string;
  readonly description: string;
  readonly chosen: boolean | undefined;
  readonly state: ModeState | ModeSnapshot["fast"] | undefined;
  readonly busy: boolean;
  readonly onRequest: (mode: D73Mode, requested: boolean) => void;
  readonly shownError: string | null;
}) {
  const unavailable = state?.state === "unavailable";
  return (
    <SettingRow
      title={title}
      description={description}
      detail={<ModeStateText mode={mode} shownError={shownError} state={state} />}
    >
      <Toolbar ariaLabel={`${title} controls`}>
        <Button
          aria-disabled={busy || chosen === true || undefined}
          aria-pressed={chosen === true}
          disabled={unavailable}
          onClick={() => {
            if (!busy && chosen !== true) onRequest(mode, true);
          }}
          type="button"
          variant={chosen === true ? "secondary" : "outline"}
        >
          Turn on
        </Button>
        <Button
          aria-disabled={busy || chosen === false || undefined}
          aria-pressed={chosen === false}
          disabled={unavailable}
          onClick={() => {
            if (!busy && chosen !== false) onRequest(mode, false);
          }}
          type="button"
          variant={chosen === false ? "secondary" : "outline"}
        >
          Turn off
        </Button>
      </Toolbar>
    </SettingRow>
  );
}

/** Pure view: placement and command ownership stay with the caller and controller. */
export function ModeControls({ model, actions }: ModeControlsProps) {
  const fast = modeState(model.snapshot, "fast");
  const browser = modeState(model.snapshot, "browser");
  const computer = modeState(model.snapshot, "computer");
  const extendedContext = modeState(model.snapshot, "extended-context");
  const slow = modeState(model.snapshot, "slow");
  const busy = model.busyMode !== null;
  // The controls are a long list and the message sits at its top: a new message scrolls into view.
  const errorBlock = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (model.error) errorBlock.current?.scrollIntoView?.({ block: "nearest" });
  }, [model.error]);
  const shownError = model.error?.message ?? null;
  return (
    <div aria-busy={busy} className="flex min-w-0 flex-col gap-4" data-d7-mode-controls>
      {model.error ? (
        <div ref={errorBlock}>
          <ErrorMessage
            error={model.error}
            kind={model.errorKind ?? "change"}
            mode={model.errorMode ?? null}
            onRetry={actions.onRetry}
          />
        </div>
      ) : null}
      <Section
        description="Choose how omp runs. Settings marked as saved apply to every chat."
        heading="Execution modes"
      >
        <div className="divide-border divide-y">
          <SettingRow
            description="Choose whether browser work runs with a visible window or without one. Saved for every chat."
            detail={<ModeStateText mode="browser" shownError={shownError} state={browser} />}
            title="Browser use"
          >
            <Toolbar ariaLabel="Browser visibility controls">
              <Button
                aria-pressed={model.browserVisibility === "headless"}
                disabled={isDisabled(browser, busy)}
                onClick={() => actions.onBrowserVisibility("headless")}
                type="button"
                variant={model.browserVisibility === "headless" ? "secondary" : "outline"}
              >
                Headless
              </Button>
              <Button
                aria-pressed={model.browserVisibility === "visible"}
                disabled={isDisabled(browser, busy)}
                onClick={() => actions.onBrowserVisibility("visible")}
                type="button"
                variant={model.browserVisibility === "visible" ? "secondary" : "outline"}
              >
                Visible window
              </Button>
            </Toolbar>
          </SettingRow>
          <ToggleRow
            description="Allow omp to use the computer-control tool in this chat."
            mode="computer"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes.computer?.requested}
            state={computer}
            title="Computer use"
            busy={busy}
            shownError={shownError}
          />
          <ToggleRow
            description="Use larger context windows where the model supports them. This can cost more. Saved for every chat."
            mode="extended-context"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes["extended-context"]?.requested}
            state={extendedContext}
            title="Extended context"
            busy={busy}
            shownError={shownError}
          />
          <ToggleRow
            description="Get faster replies when the model supports it."
            mode="fast"
            onRequest={actions.onRequest}
            chosen={fastChoice(model.snapshot.fast)}
            state={fast}
            title="Fast mode"
            busy={busy}
            shownError={shownError}
          />
          <ToggleRow
            description="Use the provider's slower, lower-cost option when it has one. Saved for every chat."
            mode="slow"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes.slow?.requested}
            state={slow}
            title="Slow mode"
            busy={busy}
            shownError={shownError}
          />
          <SettingRow
            description="Replies run as usual when none of the settings above is on."
            title={MODE_LABELS.default}
          >
            <span className="text-muted-foreground text-sm">Always available.</span>
          </SettingRow>
        </div>
      </Section>
      <div className="flex items-center justify-end gap-3">
        <Button
          disabled={busy}
          onClick={actions.onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Refresh status
        </Button>
      </div>
    </div>
  );
}

export interface ConnectedModeControlsProps {
  readonly controller: ModeControllerPort;
  readonly refreshOnMount?: boolean;
}

/** Hook/controller bridge used by the app composition root or a playground. */
export function ConnectedModeControls({
  controller,
  refreshOnMount = true,
}: ConnectedModeControlsProps) {
  const subscribe = useCallback(
    (listener: Parameters<ModeControllerPort["subscribe"]>[0]) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [busyMode, setBusyMode] = useState<ModeControlsModel["busyMode"]>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [errorKind, setErrorKind] = useState<ModeErrorKind>("change");
  const [errorMode, setErrorMode] = useState<D73Mode | null>(null);
  // "Try again" repeats the last action that was started, so a failed change is never replaced by a refresh.
  const lastAttempt = useRef<() => void>(() => undefined);
  const run = useCallback(
    async (
      kind: ModeErrorKind,
      mode: D73Mode | null,
      action: () => Promise<{ readonly ok: boolean; readonly error?: AppError }>,
    ) => {
      setError(null);
      try {
        const result = await action();
        if (!result.ok) {
          setErrorKind(kind);
          setErrorMode(mode);
          setError(
            result.error ?? {
              code: "internal",
              message: "The app could not reach omp. Try again.",
              retryable: true,
            },
          );
        }
      } catch (cause) {
        setErrorKind(kind);
        setErrorMode(mode);
        if (cause instanceof AppFailure) {
          setError(cause.appError);
        } else {
          // Not a typed answer from omp, so the app says it could not reach omp; omp is not blamed.
          setError({
            code: "internal",
            message: "The app could not reach omp. Try again.",
            retryable: true,
          });
        }
      } finally {
        setBusyMode(null);
      }
    },
    [],
  );
  const onRequest = useCallback(
    (mode: D73Mode, requested: boolean) => {
      const attempt = () => {
        setBusyMode(mode);
        void run("change", mode, () => controller.request({ mode, scope: "session", requested }));
      };
      lastAttempt.current = attempt;
      attempt();
    },
    [controller, run],
  );
  const onBrowserVisibility = useCallback(
    (visibility: BrowserVisibility) => {
      const attempt = () => {
        setBusyMode("browser");
        void run("change", "browser", () => controller.requestBrowserVisibility(visibility));
      };
      lastAttempt.current = attempt;
      attempt();
    },
    [controller, run],
  );
  const onRefresh = useCallback(() => {
    const attempt = () => {
      setBusyMode(null);
      void run("refresh", null, () => controller.refresh().then(() => ({ ok: true })));
    };
    lastAttempt.current = attempt;
    attempt();
  }, [controller, run]);
  const onRetry = useCallback(() => lastAttempt.current(), []);
  useEffect(() => {
    if (refreshOnMount) onRefresh();
  }, [onRefresh, refreshOnMount]);
  return (
    <ModeControls
      actions={{ onRequest, onBrowserVisibility, onRefresh, onRetry }}
      model={{
        snapshot,
        browserVisibility: controller.getBrowserVisibility(),
        busyMode,
        error,
        errorKind,
        errorMode,
      }}
    />
  );
}
