import { type AppError, AppFailure } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { InlineError, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { ModeSnapshot, ModeState } from "../contract";
import { type BrowserVisibility, type D73Mode, MODE_LABELS } from "./commands";
import type { ModeControllerPort } from "./controller";

type ModeErrorKind = "change" | "refresh";

export interface ModeControlsModel {
  readonly snapshot: ModeSnapshot;
  readonly browserVisibility: BrowserVisibility | null;
  readonly busyMode: D73Mode | "browser" | null;
  readonly error: AppError | null;
  /** Which action failed: a failed refresh is not reported as a failed setting change. */
  readonly errorKind?: ModeErrorKind;
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
  if (state === undefined) return "Waiting for the session to connect.";
  switch (state.state) {
    case "known":
      return knownText(mode, state);
    case "requested":
      // Fast mode has no reply to show: until omp answers, the app is checking with omp.
      if (mode === "fast") return "Checking with omp…";
      return state.reason ? `Sent to omp. ${state.reason}` : "Sent to omp.";
    case "fallback":
      return unknownText(mode, state);
    case "unavailable":
      return state.reason ? `Not available. ${state.reason}` : "Not available.";
  }
}

/**
 * omp does not report this mode's state. The line says so and what the person can do: a setting they
 * chose in this session reads as set, and until they choose one, the choice is theirs.
 */
function unknownText(mode: D73Mode, state: ModeStateLike): string {
  if (mode === "fast") return "omp has not reported Fast mode yet. Refresh status to check it.";
  const chosen = state.requested !== undefined;
  if (mode === "browser") {
    return chosen
      ? "Set for this session. omp does not report which window mode is in use."
      : "omp does not report which window mode is in use. Choose Headless or Visible window for this session.";
  }
  return chosen
    ? "Set for this session. omp does not report whether it is on."
    : "omp does not report whether this is on. Choose Turn on or Turn off for this session.";
}

/** On or off as omp reported it; for Fast mode, also whether the current model uses the tier. */
function knownText(mode: D73Mode, state: ModeStateLike): string {
  if (!state.enabled) return "Off";
  if (mode === "fast" && state.active === false) return "On, but the current model does not use it";
  return "On";
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
  onRetry,
}: {
  readonly error: AppError;
  readonly kind: ModeErrorKind;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <InlineError
      heading={
        kind === "refresh"
          ? "The execution state could not be loaded"
          : "The execution setting could not be changed"
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
}: {
  readonly mode: D73Mode;
  readonly state: ModeStateLike | undefined;
}) {
  return (
    <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
      {statusText(mode, state)}
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
}: {
  readonly mode: D73Mode;
  readonly title: string;
  readonly description: string;
  readonly chosen: boolean | undefined;
  readonly state: ModeState | ModeSnapshot["fast"] | undefined;
  readonly busy: boolean;
  readonly onRequest: (mode: D73Mode, requested: boolean) => void;
}) {
  const unavailable = state?.state === "unavailable";
  return (
    <SettingRow
      title={title}
      description={description}
      detail={<ModeStateText mode={mode} state={state} />}
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
  return (
    <div aria-busy={busy} className="flex min-w-0 flex-col gap-4" data-d7-mode-controls>
      <Section
        description="Choose how omp runs. Settings marked as saved apply to every conversation."
        heading="Execution modes"
      >
        <div className="divide-border divide-y">
          <SettingRow
            description="Choose whether browser work runs with a visible window or without one. Saved for every conversation."
            detail={<ModeStateText mode="browser" state={browser} />}
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
            description="Allow omp to use the computer-control tool in this conversation."
            mode="computer"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes.computer?.requested}
            state={computer}
            title="Computer use"
            busy={busy}
          />
          <ToggleRow
            description="Ask omp to use its wider context policy. Saved for every conversation."
            mode="extended-context"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes["extended-context"]?.requested}
            state={extendedContext}
            title="Extended context"
            busy={busy}
          />
          <ToggleRow
            description="Enable the provider's fast tier when omp supports it."
            mode="fast"
            onRequest={actions.onRequest}
            chosen={fastChoice(model.snapshot.fast)}
            state={fast}
            title="Fast mode"
            busy={busy}
          />
          <ToggleRow
            description="Use the slower execution tier when the command is available. Saved for every conversation."
            mode="slow"
            onRequest={actions.onRequest}
            chosen={model.snapshot.modes.slow?.requested}
            state={slow}
            title="Slow mode"
            busy={busy}
          />
          <SettingRow
            description="The standard path is used when no special execution mode is active."
            title={MODE_LABELS.default}
          >
            <span className="text-muted-foreground text-sm">Always available as the baseline.</span>
          </SettingRow>
        </div>
      </Section>
      {model.error ? (
        <ErrorMessage
          error={model.error}
          kind={model.errorKind ?? "change"}
          onRetry={actions.onRetry}
        />
      ) : null}
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
  // "Try again" repeats the last action that was started, so a failed change is never replaced by a refresh.
  const lastAttempt = useRef<() => void>(() => undefined);
  const run = useCallback(
    async (
      kind: ModeErrorKind,
      action: () => Promise<{ readonly ok: boolean; readonly error?: AppError }>,
    ) => {
      setError(null);
      try {
        const result = await action();
        if (!result.ok) {
          setErrorKind(kind);
          setError(
            result.error ?? {
              code: "internal",
              message: "The mode request failed.",
              retryable: true,
            },
          );
        }
      } catch (cause) {
        setErrorKind(kind);
        if (cause instanceof AppFailure) {
          setError(cause.appError);
        } else {
          setError({
            code: "internal",
            message: cause instanceof Error ? cause.message : "The mode request failed.",
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
        void run("change", () => controller.request({ mode, scope: "session", requested }));
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
        void run("change", () => controller.requestBrowserVisibility(visibility));
      };
      lastAttempt.current = attempt;
      attempt();
    },
    [controller, run],
  );
  const onRefresh = useCallback(() => {
    const attempt = () => {
      setBusyMode(null);
      void run("refresh", () => controller.refresh().then(() => ({ ok: true })));
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
      }}
    />
  );
}
