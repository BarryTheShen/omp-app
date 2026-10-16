import type { AppClient, ConnectionState, ConnectionStateEvent } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  CapabilityStatus,
  type CommandRunResult,
  OmpCommandGateway,
  type ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import { ToolAvailabilitySurface } from "../tools";
import { createD74CommandClient, type D74CommandClient } from "./commands";
import { PrewalkSurface } from "./index";
import { type D74CommandController, useD74Command } from "./use-d74-command";

interface TestClient extends AppClient {
  emit(event: ConnectionStateEvent): void;
}

function testClient(initialState: ConnectionState = "open"): TestClient {
  let state = initialState;
  const listeners = new Set<(event: ConnectionStateEvent) => void>();
  return {
    get connectionState() {
      return state;
    },
    instanceId: "d74-test-instance",
    onConnectionState(listener: (event: ConnectionStateEvent) => void) {
      listeners.add(listener);
      listener({ state, attempt: 0 });
      return () => listeners.delete(listener);
    },
    onResync: () => () => undefined,
    port: () => {
      throw new Error("the command hook uses its typed command client");
    },
    subscribe: async () => {
      throw new Error("no event subscription is used in this test");
    },
    dispose: () => undefined,
    emit(event: ConnectionStateEvent) {
      state = event.state;
      for (const listener of listeners) listener(event);
    },
  } as unknown as TestClient;
}

const capabilities: CapabilityMap = {
  "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
};

const completed: CommandRunResult = {
  command: "/prewalk",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [{ text: "Prewalk armed." }],
  sessionUpdates: [],
  configUpdates: [],
};

function HookHarness({
  client,
  commandClient,
  threadId,
  commandCapabilities = capabilities,
  controllerRef,
}: {
  readonly client: TestClient;
  readonly commandClient: D74CommandClient;
  readonly threadId: ThreadId;
  readonly commandCapabilities?: CapabilityMap;
  readonly controllerRef?: { current: D74CommandController | undefined };
}) {
  const controller = useD74Command({
    client,
    commandClient,
    threadId,
    capabilities: commandCapabilities,
  });
  if (controllerRef) controllerRef.current = controller;
  return (
    <>
      <PrewalkSurface
        canRun={controller.canRun}
        onRetry={controller.actions.retry}
        onRun={controller.actions.run}
        surface={controller.surface}
      />
      <ToolAvailabilitySurface
        canRun={controller.canRun}
        onList={() => controller.actions.run("/tools")}
        onRetry={controller.actions.retry}
        onSkillful={controller.actions.run}
        surface={controller.surface}
        tools={[]}
      />
      <p data-testid="surface-state">{controller.surface.state}</p>
      <p data-testid="surface-message">{controller.surface.message}</p>
      <p data-testid="can-run">{String(controller.canRun)}</p>
    </>
  );
}

function renderHarness({
  client = testClient(),
  commandClient,
  threadId = "thread-one" as ThreadId,
  commandCapabilities,
  controllerRef,
}: {
  readonly client?: TestClient;
  readonly commandClient: D74CommandClient;
  readonly threadId?: ThreadId;
  readonly commandCapabilities?: CapabilityMap;
  readonly controllerRef?: { current: D74CommandController | undefined };
}) {
  return render(
    <OverlayHost>
      <HookHarness
        client={client}
        commandCapabilities={commandCapabilities}
        commandClient={commandClient}
        controllerRef={controllerRef}
        threadId={threadId}
      />
    </OverlayHost>,
  );
}

afterEach(() => cleanup());

describe("D7.4 command controller", () => {
  test("uses A1's typed command method with the current thread and abort signal", async () => {
    const run = vi.fn(async () => completed);
    const ports: unknown[] = [];
    const client = {
      port(port: unknown) {
        ports.push(port);
        return { run };
      },
    } as unknown as Pick<AppClient, "port">;
    const typed = createD74CommandClient(client);
    const controller = new AbortController();

    await typed.run("thread-one" as ThreadId, "/prewalk", { signal: controller.signal });

    expect(ports).toEqual([OmpCommandGateway]);
    expect(run).toHaveBeenCalledWith(
      { threadId: "thread-one", command: "/prewalk" },
      { signal: controller.signal },
    );
  });

  test("ignores a second action while one command is in flight", async () => {
    const deferred = Promise.withResolvers<CommandRunResult>();
    const run = vi.fn(() => deferred.promise);
    const controllerRef: { current: D74CommandController | undefined } = { current: undefined };
    renderHarness({ commandClient: { run }, controllerRef });

    act(() => {
      controllerRef.current?.actions.run("/prewalk");
      controllerRef.current?.actions.run("/prewalk restart");
    });

    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByTestId("surface-state").textContent).toBe("requested");
    await act(async () => deferred.resolve(completed));
    expect(screen.getByTestId("surface-state").textContent).toBe("complete");
  });

  test("shows the waiting notice in both sections while prewalk runs", async () => {
    const deferred = Promise.withResolvers<CommandRunResult>();
    renderHarness({ commandClient: { run: () => deferred.promise } });

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );

    const preparation = screen.getByRole("region", { name: "Preparation and context" });
    const tools = screen.getByRole("region", { name: "Tools and skills" });
    expect(preparation.textContent).toContain("Waiting for omp to answer.");
    expect(tools.textContent).toContain("Waiting for omp to answer.");
    await act(async () => deferred.resolve(completed));
  });

  test("aborts on thread change and drops the stale response", async () => {
    const deferred = Promise.withResolvers<CommandRunResult>();
    let receivedSignal: AbortSignal | undefined;
    const commandClient: D74CommandClient = {
      run: async (_thread, _command, options) => {
        receivedSignal = options?.signal as AbortSignal | undefined;
        return deferred.promise;
      },
    };
    const client = testClient();
    const view = renderHarness({ commandClient, client });
    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );
    view.rerender(
      <OverlayHost>
        <HookHarness
          client={client}
          commandClient={commandClient}
          threadId={"thread-two" as ThreadId}
        />
      </OverlayHost>,
    );
    expect(receivedSignal?.aborted).toBe(true);
    await act(async () => deferred.resolve(completed));
    expect(screen.getByTestId("surface-state").textContent).toBe("idle");
  });

  test("aborts an in-flight command on unmount", () => {
    let receivedSignal: AbortSignal | undefined;
    const commandClient: D74CommandClient = {
      run: async (_thread, _command, options) => {
        receivedSignal = options?.signal as AbortSignal | undefined;
        return new Promise<CommandRunResult>(() => undefined);
      },
    };
    const view = renderHarness({ commandClient });
    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );
    view.unmount();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("reports unknown state after reconnect", async () => {
    const client = testClient();
    renderHarness({ client, commandClient: { run: async () => completed } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );
    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    act(() => client.emit({ state: "open", attempt: 1 }));
    expect(screen.getByTestId("surface-state").textContent).toBe("unknown");
    expect(screen.getByTestId("surface-message").textContent).toContain("reconnected");
  });

  test("clears reconnecting state when it reconnects before any command ran", () => {
    const client = testClient("reconnecting");
    renderHarness({ client, commandClient: { run: async () => completed } });
    expect(screen.getByTestId("surface-message").textContent).toContain("reconnecting");
    act(() => client.emit({ state: "open", attempt: 1 }));
    expect(screen.getByTestId("surface-state").textContent).toBe("idle");
    expect(screen.getByTestId("surface-message").textContent).toBe("");
    expect(screen.getByTestId("can-run").textContent).toBe("true");
  });

  test("clears the reconnect notice when an initial retry opens", () => {
    const client = testClient("connecting");
    renderHarness({ client, commandClient: { run: async () => completed } });
    act(() => client.emit({ state: "reconnecting", attempt: 1 }));
    expect(screen.getByTestId("surface-state").textContent).toBe("unavailable");
    act(() => client.emit({ state: "open", attempt: 1 }));
    expect(screen.getByTestId("surface-state").textContent).toBe("idle");
    expect(screen.getByTestId("surface-message").textContent).toBe("");
    expect(screen.getByTestId("can-run").textContent).toBe("true");
  });

  test("gates controls when the typed command gateway is unavailable", () => {
    renderHarness({
      commandCapabilities: {},
      commandClient: { run: async () => completed },
    });
    expect(
      (screen.getByRole("button", { name: "Switch model at the next edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByTestId("surface-message").textContent).toBe(
      "Commands are not available in this chat.",
    );
  });

  test("requires confirmation before shake and sends nothing when cancelled", async () => {
    const run = vi.fn(async () => completed);
    renderHarness({ commandClient: { run } });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Drop images from context" })));
    expect(screen.getByText("Remove content from this chat?")).toBeTruthy();
    expect(screen.getByTestId("surface-state").textContent).toBe("confirming");
    expect(screen.queryByText("Waiting for omp to answer.")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId("surface-state").textContent).toBe("idle");
  });

  test("names the content removed in each shake confirmation", async () => {
    const run = vi.fn(async () => completed);
    renderHarness({ commandClient: { run } });
    const confirmations = [
      ["Drop tool results and large blocks", "tool results and large blocks"],
      ["Drop images from context", "images"],
      ["Drop thinking from context", "thinking"],
    ] as const;

    for (const [buttonName, removedContent] of confirmations) {
      act(() => fireEvent.click(screen.getByRole("button", { name: buttonName })));
      expect(screen.getByRole("dialog").textContent).toContain(
        `omp will remove ${removedContent} from the context it can use.`,
      );
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    }

    expect(run).not.toHaveBeenCalled();
  });

  test("shows both waiting notices only after confirming shake", async () => {
    const deferred = Promise.withResolvers<CommandRunResult>();
    const run = vi.fn(() => deferred.promise);
    renderHarness({ commandClient: { run } });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Drop images from context" })));
    expect(screen.queryByText("Waiting for omp to answer.")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove content" })));
    expect(screen.getAllByText("Waiting for omp to answer.")).toHaveLength(2);
    expect(run).toHaveBeenCalledOnce();
    await act(async () => deferred.resolve(completed));
  });

  test("carries typed AppFailure messages but hides arbitrary error text", async () => {
    const unavailable: D74CommandClient = {
      run: async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "Command not available.",
          retryable: false,
        });
      },
    };
    renderHarness({ commandClient: unavailable });
    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Command not available.");

    cleanup();
    const privateError: D74CommandClient = {
      run: async () => {
        throw new Error("/home/secret/config.yml");
      },
    };
    renderHarness({ commandClient: privateError });
    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Switch model at the next edit" })),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The app could not reach omp. Try again.",
    );
  });
});
