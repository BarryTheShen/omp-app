import {
  type AppClient,
  type ConnectionState as ClientConnectionState,
  type ConnectionStateEvent,
  type CreateAppClientOptions,
  createAppClient,
} from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { LogHint } from "./log-hint";
import {
  type LaunchLocationLike,
  readLaunchToken,
  type TokenHistoryLike,
  type TokenStorageLike,
  websocketUrl,
} from "./token";

export type AppConnectionState =
  | "missing-token"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "rejected"
  | "closed";

export interface AppConnectionSnapshot {
  readonly client: AppClient | null;
  readonly state: AppConnectionState;
  readonly reason?: string;
  readonly websocketUrl?: string;
}

export interface AppConnectionProviderProps {
  readonly children: ReactNode;
  readonly location?: LaunchLocationLike;
  readonly storage?: TokenStorageLike;
  readonly history?: TokenHistoryLike;
  readonly createClient?: (options: CreateAppClientOptions) => AppClient;
}

const EMPTY_CONNECTION: AppConnectionSnapshot = Object.freeze({
  client: null,
  state: "connecting",
});

const AppConnectionContext = createContext<AppConnectionSnapshot | null>(null);

function stateFromClient(
  state: ClientConnectionState,
  error: ConnectionStateEvent["error"],
): AppConnectionState {
  if (state === "open") return "connected";
  if (state === "reconnecting" || state === "connecting") return state;
  if (error?.code === "permission") return "rejected";
  return "closed";
}

function connectionError(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The app server rejected the launch token.";
}

export function AppConnectionProvider({
  children,
  location,
  storage,
  history,
  createClient = createAppClient,
}: AppConnectionProviderProps) {
  const [launch, setLaunch] = useState<ReturnType<typeof readLaunchToken> | null>(null);
  const [snapshot, setSnapshot] = useState<AppConnectionSnapshot>(EMPTY_CONNECTION);

  useEffect(() => {
    setLaunch(readLaunchToken({ location, storage, history }));
  }, [history, location, storage]);

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

    const update = ({ state, attempt, error }: ConnectionStateEvent): void => {
      const mappedState = stateFromClient(state, error);
      const reason =
        mappedState === "rejected"
          ? "This launch link has expired. Open the URL the app printed when it last started."
          : mappedState === "connecting" && attempt >= 3
            ? `Can't reach the app server at ${url}. Retrying…`
            : undefined;
      setSnapshot({
        client,
        state: mappedState,
        ...(reason ? { reason } : {}),
        websocketUrl: url,
      });
    };
    const unsubscribe = client.onConnectionState(update);
    update({ state: client.connectionState, attempt: 0 });
    return () => {
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

function LaunchStatusScreen({ state, reason }: Pick<AppConnectionSnapshot, "state" | "reason">) {
  const missing = state === "missing-token";
  const rejected = state === "rejected";
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
            : rejected
              ? "This launch link has expired"
              : connecting
                ? "Connecting to omp-app"
                : "Could not connect to omp-app"}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {missing
            ? "Start the app server, then open the URL it prints. The launch token is supplied in the URL fragment and is kept only for this browser session."
            : (reason ?? "The app server is unavailable. The client will keep trying to connect.")}
        </p>
        {rejected && (
          <p className="text-muted-foreground text-sm">
            Start the app again to receive a fresh launch URL, then reload this page.
          </p>
        )}
        <LogHint />
      </section>
    </main>
  );
}

/** Holds the app shell until a token is available; the rest of the app reads only `useAppConnection`. */
export function AppConnectionGate({ children }: { readonly children: ReactNode }) {
  const connection = useAppConnection();
  if (
    connection.state === "missing-token" ||
    connection.state === "rejected" ||
    connection.state === "closed" ||
    (connection.state === "connecting" && connection.reason !== undefined)
  ) {
    return <LaunchStatusScreen state={connection.state} reason={connection.reason} />;
  }
  return <>{children}</>;
}

export { LaunchStatusScreen };
