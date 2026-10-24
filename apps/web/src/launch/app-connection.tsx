import {
  type AppClient,
  type ConnectionState as ClientConnectionState,
  type ConnectionStateEvent,
  type CreateAppClientOptions,
  createAppClient,
} from "@omp-app/client";
import { AppFailure, type FolderPath } from "@omp-app/contracts";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LogHint } from "./log-hint";
import {
  type LaunchLocationLike,
  launchTokenInFragment,
  readLaunchToken,
  type TokenHistoryLike,
  type TokenStorageLike,
  websocketUrl,
} from "./token";

/**
 * `reconnecting`: a connection that was open dropped; the app keeps retrying and keeps its screen.
 * `connecting`: the first connection, before the app has ever been open.
 * `rejected`: the server refused an expired launch link.
 * `origin-rejected`: the page address is not allowed to connect to the app.
 * `invalid-token`: the server refused a launch link no start of the app ever printed.
 */
export type AppConnectionState =
  | "missing-token"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "rejected"
  | "origin-rejected"
  | "invalid-token"
  | "closed";

export interface AppConnectionSnapshot {
  readonly client: AppClient | null;
  readonly state: AppConnectionState;
  readonly reason?: string;
  readonly websocketUrl?: string;
  /** True once reconnects have failed for UNREACHABLE_AFTER_MS: the server is probably not running. */
  readonly unreachable?: boolean;
}

export interface AppConnectionProviderProps {
  readonly children: ReactNode;
  readonly location?: LaunchLocationLike;
  readonly storage?: TokenStorageLike;
  readonly history?: TokenHistoryLike;
  readonly createClient?: (options: CreateAppClientOptions) => AppClient;
  /** Loads the page again. A launch link typed into the open tab reloads it with that link; the default reloads the window. */
  readonly reload?: () => void;
  /**
   * Told the folder a launch link asks the app to open on, once, when the page reads its address. Keep the function
   * the same between renders: a new one reads the address again.
   */
  readonly onLaunchFolder?: (folder: FolderPath) => void;
}

/** How long reconnects may fail before the banner says the server is not answering, and what to do. */
const UNREACHABLE_AFTER_MS = 30_000;

const EMPTY_CONNECTION: AppConnectionSnapshot = Object.freeze({
  client: null,
  state: "connecting",
});

const AppConnectionContext = createContext<AppConnectionSnapshot | null>(null);

/**
 * Maps the client's state. Once this connection has been open, a retry the client reports as `connecting`
 * is a reconnect, so the app keeps its screen while it retries.
 */
function stateFromClient(
  state: ClientConnectionState,
  error: ConnectionStateEvent["error"],
  hasConnected: boolean,
  refusal: ConnectionStateEvent["refusal"],
): AppConnectionState {
  if (state === "open") return "connected";
  if (state === "reconnecting") return "reconnecting";
  if (state === "connecting") return hasConnected ? "reconnecting" : "connecting";
  if (error?.code === "permission") {
    if (refusal === "origin") return "origin-rejected";
    return refusal === "invalid" ? "invalid-token" : "rejected";
  }
  return "closed";
}

function connectionError(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The app server rejected the launch token.";
}

/** Reloads the page, which reads the launch token again from its address. */
function reloadWindow(): void {
  window.location.reload();
}

export function AppConnectionProvider({
  children,
  location,
  storage,
  history,
  createClient = createAppClient,
  reload = reloadWindow,
  onLaunchFolder,
}: AppConnectionProviderProps) {
  const [launch, setLaunch] = useState<ReturnType<typeof readLaunchToken> | null>(null);
  const [snapshot, setSnapshot] = useState<AppConnectionSnapshot>(EMPTY_CONNECTION);

  useEffect(() => {
    const result = readLaunchToken({ location, storage, history });
    // The first read gives the folder up; a second read (StrictMode runs effects twice) finds the address stripped.
    if (result.folder !== null) onLaunchFolder?.(result.folder);
    setLaunch(result);
  }, [history, location, onLaunchFolder, storage]);

  // A launch link typed into this open tab changes only the fragment: the page does not load again, and the token
  // read above stays the old one. A different token is a new link from a restarted app: load the page with it.
  useEffect(() => {
    if (launch === null) return;
    const onHashChange = (): void => {
      const typed = launchTokenInFragment((location ?? window.location).hash);
      if (typed !== null && typed !== launch.token) reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [launch, location, reload]);

  useEffect(() => {
    if (launch === null) return;
    if (launch.token === null) {
      setSnapshot({ client: null, state: "missing-token" });
      return;
    }

    const pageLocation = location ?? (typeof window === "undefined" ? undefined : window.location);
    if (!pageLocation) {
      setSnapshot({
        client: null,
        state: "closed",
        reason: "A browser location is required to connect to the app server.",
      });
      return;
    }
    const url = websocketUrl(pageLocation);
    let client: AppClient;
    try {
      client = createClient({ url, token: launch.token });
    } catch (error) {
      setSnapshot({
        client: null,
        state: "closed",
        reason: connectionError(error),
        websocketUrl: url,
      });
      return;
    }

    // A retry after the first connection is a reconnect, so the screen stays up (see stateFromClient).
    let hasConnected = false;
    // After UNREACHABLE_AFTER_MS of failed reconnects the snapshot says so, and the banner says what to do.
    let unreachable = false;
    let unreachableTimer: number | undefined;
    const update = ({ state, attempt, error, refusal }: ConnectionStateEvent): void => {
      if (state === "open") hasConnected = true;
      const mappedState = stateFromClient(state, error, hasConnected, refusal);
      if (mappedState !== "reconnecting") {
        window.clearTimeout(unreachableTimer);
        unreachableTimer = undefined;
        unreachable = false;
      } else if (!unreachable && unreachableTimer === undefined) {
        unreachableTimer = window.setTimeout(() => {
          unreachableTimer = undefined;
          unreachable = true;
          setSnapshot((current) => ({ ...current, unreachable: true }));
        }, UNREACHABLE_AFTER_MS);
      }
      const reason =
        mappedState === "rejected"
          ? "Open the URL the app printed when it last started."
          : mappedState === "origin-rejected"
            ? "Open the URL the app printed when it last started, from the same machine."
            : mappedState === "invalid-token"
              ? "Open the full URL the app printed when it last started, including the part after the #."
              : mappedState === "connecting" && attempt >= 3
                ? `Can't reach the app server at ${url}. Retrying…`
                : undefined;
      setSnapshot({
        client,
        state: mappedState,
        ...(reason ? { reason } : {}),
        websocketUrl: url,
        unreachable,
      });
    };
    const unsubscribe = client.onConnectionState(update);
    update({ state: client.connectionState, attempt: 0 });
    return () => {
      window.clearTimeout(unreachableTimer);
      unsubscribe();
      client.dispose();
    };
  }, [createClient, launch, location]);

  return <AppConnectionContext.Provider value={snapshot}>{children}</AppConnectionContext.Provider>;
}

export function useAppConnection(): AppConnectionSnapshot {
  const context = useContext(AppConnectionContext);
  if (context === null) {
    throw new Error("useAppConnection must be used inside AppConnectionProvider");
  }
  return context;
}

function LaunchStatusScreen({
  state,
  reason,
  onRetry,
}: Pick<AppConnectionSnapshot, "state" | "reason"> & {
  readonly onRetry?: () => void;
}) {
  const missing = state === "missing-token";
  const rejected = state === "rejected";
  const originRejected = state === "origin-rejected";
  const invalid = state === "invalid-token";
  const connecting = state === "connecting";
  return (
    <main
      aria-labelledby="launch-status-title"
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground"
      data-launch-state={state}
    >
      <section className="w-full max-w-xl space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight" id="launch-status-title">
          {missing
            ? "Start omp-app to connect"
            : originRejected
              ? "This page address is not allowed to reach omp-app"
              : rejected
                ? "This launch link has expired"
                : invalid
                  ? "This launch link is not valid"
                  : connecting
                    ? "Connecting to omp-app"
                    : "Could not connect to omp-app"}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {missing
            ? "Start the app server, then open the URL it prints. The launch token is supplied in the URL fragment and is kept only for this browser session."
            : (reason ??
              (connecting
                ? "Waiting for the app server to answer."
                : "The app server is unavailable. The client will keep trying to connect."))}
        </p>
        {rejected && (
          <p className="text-muted-foreground text-sm">
            Start the app again to receive a fresh launch URL, then reload this page.
          </p>
        )}
        {onRetry ? (
          <Button type="button" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        <LogHint />
      </section>
    </main>
  );
}

/**
 * Holds the app shell until a token is available; the rest of the app reads only `useAppConnection`. A drop
 * after the first connection keeps the shell up while the app retries; the full-page screen is for the first
 * connection and for a launch link the server refuses.
 */
export function AppConnectionGate({ children }: { readonly children: ReactNode }) {
  const connection = useAppConnection();
  if (
    connection.state === "missing-token" ||
    connection.state === "rejected" ||
    connection.state === "invalid-token" ||
    connection.state === "origin-rejected" ||
    connection.state === "closed" ||
    connection.state === "connecting"
  ) {
    return <LaunchStatusScreen state={connection.state} reason={connection.reason} />;
  }
  return <>{children}</>;
}

export { LaunchStatusScreen };
