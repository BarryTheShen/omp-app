import type { AppClient, ConnectionStateEvent, CreateAppClientOptions } from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AppConnectionGate,
  AppConnectionProvider,
  LaunchStatusScreen,
  useAppConnection,
} from "./app-connection";
import { DEFAULT_LOG_FILE, rememberLogFile } from "./log-location";
import type { LaunchLocationLike } from "./token";

const pageLocation: LaunchLocationLike = {
  hash: "#token=fragment-token",
  pathname: "/",
  search: "",
  protocol: "http:",
  host: "127.0.0.1:4317",
};

type TestClient = AppClient & { emit(next: ConnectionStateEvent): void };

function makeClient(state: "connecting" | "open" = "open"): TestClient {
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
  return client as unknown as TestClient;
}

function Harness() {
  const connection = useAppConnection();
  return (
    <>
      <output data-testid="connection-state">{connection.state}</output>
      <output data-testid="connection-unreachable">
        {String(connection.unreachable === true)}
      </output>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("app connection launch gate", () => {
  test("shows Retry when the first answers fail", () => {
    const retry = vi.fn();
    render(
      <LaunchStatusScreen state="closed" reason="The first answers failed." onRetry={retry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  test("the first connection says it is waiting, not that the server is unavailable", () => {
    render(<LaunchStatusScreen state="connecting" />);
    expect(screen.getByText("Waiting for the app server to answer.")).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });

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

  test("a drop after the app connected keeps the app on screen while it retries", async () => {
    const client = makeClient("open");
    render(
      <AppConnectionProvider
        createClient={() => client}
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

    // The socket drops and the next three tries fail: the app keeps its screen and says it is reconnecting.
    act(() => {
      client.emit({ state: "reconnecting", attempt: 1 });
      client.emit({ state: "connecting", attempt: 2 });
      client.emit({ state: "connecting", attempt: 3 });
      client.emit({ state: "connecting", attempt: 4 });
    });
    expect(screen.getByTestId("connection-state").textContent).toBe("reconnecting");
    expect(screen.queryByRole("heading", { name: "Connecting to omp-app" })).toBeNull();

    act(() => client.emit({ state: "open", attempt: 0 }));
    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
    );
  });

  test("a first connection that cannot reach the app keeps the full-page screen", async () => {
    const client = makeClient("connecting");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );

    act(() => {
      client.emit({ state: "connecting", attempt: 1 });
      client.emit({ state: "connecting", attempt: 2 });
      client.emit({ state: "connecting", attempt: 3 });
    });
    expect(await screen.findByRole("heading", { name: "Connecting to omp-app" })).toBeTruthy();
    expect(
      screen.getByText("Can't reach the app server at ws://127.0.0.1:4317/ws. Retrying…"),
    ).toBeTruthy();
  });

  test("a launch link that expires during a drop still gets the expired-link screen", async () => {
    const client = makeClient("open");
    render(
      <AppConnectionProvider
        createClient={() => client}
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

    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    act(() =>
      client.emit({
        state: "closed",
        attempt: 1,
        error: {
          code: "permission",
          message: "Launch link has expired",
          retryable: false,
        },
        refusal: "expired",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "This launch link has expired" }),
    ).toBeTruthy();
  });
  test("a disallowed page address is not described as an expired launch link", async () => {
    const client = makeClient("connecting");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    act(() =>
      client.emit({
        state: "closed",
        attempt: 0,
        error: {
          code: "permission",
          message: "This page address is not allowed to reach omp-app",
          retryable: false,
        },
        refusal: "origin",
      }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "This page address is not allowed to reach omp-app",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Open the URL the app printed when it last started, from the same machine."),
    ).toBeTruthy();
    expect(screen.queryByText(/expired/i)).toBeNull();
    expect(screen.getByRole("main").getAttribute("data-launch-state")).toBe("origin-rejected");
  });

  test("a launch link the app never printed says it is not valid, and never that it expired", async () => {
    const client = makeClient("connecting");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    act(() =>
      client.emit({
        state: "closed",
        attempt: 0,
        error: { code: "permission", message: "Launch token is not valid", retryable: false },
        refusal: "invalid",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "This launch link is not valid" }),
    ).toBeTruthy();
    expect(screen.getByText(/Open the full URL the app printed when it last started/)).toBeTruthy();
    expect(screen.queryByText(/expired/i)).toBeNull();
  });

  test("a launch link an earlier start printed says it has expired and how to get a new one", async () => {
    const client = makeClient("connecting");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    act(() =>
      client.emit({
        state: "closed",
        attempt: 0,
        error: { code: "permission", message: "Launch link has expired", retryable: false },
        refusal: "expired",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "This launch link has expired" }),
    ).toBeTruthy();
    expect(screen.getByText("Open the URL the app printed when it last started.")).toBeTruthy();
    expect(screen.getByText("Running omp-app again prints its current link.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This launch link is not valid" })).toBeNull();
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

  test("a server that stays down says what to do after 30 seconds of failed tries", () => {
    vi.useFakeTimers();
    const client = makeClient("open");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    expect(screen.getByTestId("connection-state").textContent).toBe("connected");

    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(screen.getByTestId("connection-unreachable").textContent).toBe("false");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("connection-state").textContent).toBe("reconnecting");
    expect(screen.getByTestId("connection-unreachable").textContent).toBe("true");

    // The server answers again: the warning goes, and the next outage counts from zero.
    act(() => client.emit({ state: "open", attempt: 0 }));
    expect(screen.getByTestId("connection-unreachable").textContent).toBe("false");
    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(screen.getByTestId("connection-unreachable").textContent).toBe("false");
  });

  test("a connection that comes back within 30 seconds never says the server is unreachable", () => {
    vi.useFakeTimers();
    const client = makeClient("open");
    render(
      <AppConnectionProvider
        createClient={() => client}
        history={{ replaceState: vi.fn() }}
        location={pageLocation}
        storage={{ getItem: () => null, setItem: vi.fn() }}
      >
        <AppConnectionGate>
          <Harness />
        </AppConnectionGate>
      </AppConnectionProvider>,
    );
    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    act(() => client.emit({ state: "open", attempt: 0 }));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("connection-unreachable").textContent).toBe("false");
  });
});

describe("a launch link typed into the open tab", () => {
  test("a different token reloads the page, which opens the app with that token", async () => {
    const reload = vi.fn();
    const location = { ...pageLocation };
    render(
      <AppConnectionProvider
        createClient={() => makeClient("open")}
        history={{ replaceState: () => undefined }}
        location={location}
        reload={reload}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <Harness />
      </AppConnectionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
    );
    location.hash = "#token=typed-token";
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("the same token, or a fragment without one, leaves the page as it is", async () => {
    const reload = vi.fn();
    const location = { ...pageLocation };
    render(
      <AppConnectionProvider
        createClient={() => makeClient("open")}
        history={{ replaceState: () => undefined }}
        location={location}
        reload={reload}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <Harness />
      </AppConnectionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
    );
    for (const hash of ["#token=fragment-token", "#tab=history"]) {
      location.hash = hash;
      act(() => {
        window.dispatchEvent(new Event("hashchange"));
      });
    }
    expect(reload).not.toHaveBeenCalled();
  });

  test("a page with no token takes a typed link that has one", async () => {
    const reload = vi.fn();
    const location = { ...pageLocation, hash: "" };
    render(
      <AppConnectionProvider
        createClient={() => makeClient("open")}
        history={{ replaceState: () => undefined }}
        location={location}
        reload={reload}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <Harness />
      </AppConnectionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("missing-token"),
    );
    location.hash = "#token=typed-token";
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("the folder a launch link asks for", () => {
  function renderLink(hash: string) {
    const onLaunchFolder = vi.fn();
    const replaceState = vi.fn();
    render(
      <AppConnectionProvider
        createClient={() => makeClient("open")}
        history={{ replaceState }}
        location={{ ...pageLocation, hash }}
        onLaunchFolder={onLaunchFolder}
        storage={{ getItem: () => null, setItem: () => undefined }}
      >
        <Harness />
      </AppConnectionProvider>,
    );
    return { onLaunchFolder, replaceState };
  }

  test("is given to the app once, and leaves the address with the token", async () => {
    const { onLaunchFolder, replaceState } = renderLink(
      "#token=fragment-token&folder=%2Fwork%2Fproject",
    );
    await waitFor(() =>
      expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
    );
    expect(onLaunchFolder).toHaveBeenCalledTimes(1);
    expect(onLaunchFolder).toHaveBeenCalledWith("/work/project");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  test("is not given when the link has none, or when its folder is not an absolute path", async () => {
    for (const hash of ["#token=fragment-token", "#token=fragment-token&folder=work%2Fproject"]) {
      const { onLaunchFolder } = renderLink(hash);
      await waitFor(() =>
        expect(screen.getByTestId("connection-state").textContent).toBe("connected"),
      );
      expect(onLaunchFolder).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
