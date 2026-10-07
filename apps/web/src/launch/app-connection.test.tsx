import type { AppClient, ConnectionStateEvent, CreateAppClientOptions } from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "./app-connection";
import { DEFAULT_LOG_FILE, rememberLogFile } from "./log-location";
import type { LaunchLocationLike } from "./token";

const pageLocation: LaunchLocationLike = {
  hash: "#token=fragment-token",
  pathname: "/",
  search: "",
  protocol: "http:",
  host: "127.0.0.1:4317",
};

function makeClient(state: "connecting" | "open" = "open"): AppClient {
  const listeners = new Set<(event: ConnectionStateEvent) => void>();
  const client = {
    connectionState: state,
    instanceId: "test-instance",
    onConnectionState(listener: (event: ConnectionStateEvent) => void) {
      listeners.add(listener);
      listener({ state, attempt: 0 });
      return () => listeners.delete(listener);
    },
    onResync: () => () => undefined,
    port: () => ({}) as never,
    subscribe: async () => ({
      stream: "test",
      lastSeq: 0,
      onEvent: () => () => undefined,
      unsubscribe: async () => undefined,
    }),
    dispose: vi.fn(),
    emit(next: ConnectionStateEvent) {
      for (const listener of listeners) listener(next);
    },
  };
  return client as unknown as AppClient;
}

function Harness() {
  const connection = useAppConnection();
  return <output data-testid="connection-state">{connection.state}</output>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("app connection launch gate", () => {
  test("shows a clear start instruction when no token is available", async () => {
    render(
      <AppConnectionProvider
        location={{ ...pageLocation, hash: "" }}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Start omp-app to connect" })).toBeTruthy();
    expect(screen.getByText(/launch token is supplied in the URL fragment/i)).toBeTruthy();
  });

  test("creates A0's client with the page origin and fragment token", async () => {
    const client = makeClient("open");
    let options: CreateAppClientOptions | undefined;
    const createClient = (next: CreateAppClientOptions) => {
      options = next;
      return client;
    };
    render(
      <AppConnectionProvider
        createClient={createClient}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
    );
    expect(options).toMatchObject({ url: "ws://127.0.0.1:4317/ws", token: "fragment-token" });
    expect(screen.queryByRole("heading", { name: "Start omp-app to connect" })).toBeNull();
  });

  test("shows the server reason on a rejected token", async () => {
    const failure = new AppFailure({
      code: "permission",
      message: "The launch token is invalid",
      retryable: false,
    });
    render(
      <AppConnectionProvider
        createClient={() => {
          throw failure;
        }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Could not connect to omp-app" }),
    ).toBeTruthy();
    expect(screen.getByText("The launch token is invalid")).toBeTruthy();
  });

  test("the can't-connect screens say where the app's log is: its default first, then the path the server last reported", async () => {
    window.localStorage.removeItem("omp-app.log-file");
    const first = render(
      <AppConnectionProvider
        location={{ ...pageLocation, hash: "" }}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    const hint = await screen.findByText(/The app keeps a log of what it does/);
    expect(hint.textContent).toContain("omp-app logs");
    expect(hint.textContent).toContain("omp-app debug-report");
    expect(hint.textContent).toContain(DEFAULT_LOG_FILE);
    first.unmount();

    rememberLogFile("/var/state/omp-app/omp-app.log");
    try {
      render(
        <AppConnectionProvider
          createClient={() => {
            throw new AppFailure({ code: "permission", message: "refused", retryable: false });
          }}
          location={pageLocation}
          storage={{ getItem: () => null, setItem: () => undefined }}
        >
          <AppConnectionGate>
            <Harness />
          </AppConnectionGate>
        </AppConnectionProvider>,
      );
      const second = await screen.findByText(/The app keeps a log of what it does/);
      expect(second.textContent).toContain("/var/state/omp-app/omp-app.log");
      expect(second.textContent).not.toContain(DEFAULT_LOG_FILE);
    } finally {
      window.localStorage.removeItem("omp-app.log-file");
    }
  });
});
