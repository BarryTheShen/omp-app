import {
  type CapabilityMap,
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  type ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModeCommandGateway } from "../contract";
import { ModeController } from "./controller";
import { ConnectedModeControls, ModeControls } from "./view";

const threadId = "d7-mode-view" as ThreadId;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "omp" }),
    ...overrides,
  };
}

/** A gateway that answers each change with `answer(request)`, and records each request it is sent. */
function gatewayAnswering(
  answer: (request: ModeChangeRequest) => ModeChangeResult,
  requests: ModeChangeRequest[] = [],
): ModeCommandGateway {
  return {
    change: async ({ request }) => {
      requests.push(request);
      return answer(request);
    },
  };
}

/** A reply the app does not recognise, carrying omp's words as sent. */
function unknownReply(words: readonly string[]): ModeChangeResult {
  return { outcome: "unknown", mode: "computer", outputs: [...words] };
}

afterEach(cleanup);

describe("D7 mode controls", () => {
  test("renders browser visibility, toggles and a refresh action with keyboard buttons", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: gatewayAnswering(() => unknownReply([])),
    });
    const actions = {
      onRequest: vi.fn(),
      onBrowserVisibility: vi.fn(),
      onRefresh: vi.fn(),
    };

    render(
      <ModeControls
        actions={actions}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Execution modes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Headless" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Visible window" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Turn on" }).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Headless" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(actions.onBrowserVisibility).toHaveBeenCalledWith("headless");
    expect(actions.onRefresh).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test("shows an unavailable reason and disables the affected control", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({
          state: "unavailable",
          via: "host",
          detail: "The command service is offline.",
        }),
      }),
    });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );

    const headless = screen.getByRole("button", { name: "Headless" });
    expect(headless).toHaveProperty("disabled", true);
    expect(screen.getAllByRole("status")[0]?.textContent).toBe(
      "These settings are not available here.",
    );
    controller.dispose();
  });

  test("try again repeats the change that failed instead of refreshing", async () => {
    const requests: ModeChangeRequest[] = [];
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        change: async ({ request }) => {
          requests.push(request);
          throw new Error("The gateway dropped the connection.");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);

    const computer = screen.getByRole("group", { name: "Computer use controls" });
    fireEvent.click(within(computer).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Computer use could not be changed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(requests).toEqual([
        { mode: "computer", requested: true },
        { mode: "computer", requested: true },
      ]),
    );
    controller.dispose();
  });

  test("shows one plain status line per mode, and none for standard execution", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: gatewayAnswering(() => unknownReply([])),
    });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );
    expect(screen.getAllByRole("status").map((element) => element.textContent)).toEqual([
      "omp does not say whether its browser window is visible. Choose Headless or Visible window for this chat.",
      "omp does not report whether this is on. Choose Turn on or Turn off for this chat.",
      "omp does not report whether this is on. Choose Turn on or Turn off for this chat.",
      "Fast mode is not available until the app is connected to omp.",
      "Slow mode is not available until the app is connected to omp.",
    ]);
    controller.dispose();
  });

  test.each([
    { enabled: true, active: true, text: "On" },
    { enabled: false, active: false, text: "Off" },
    { enabled: true, active: false, text: "On, but the current model does not use it" },
  ])(
    "fast mode reads '$text' when omp reports enabled $enabled and active $active",
    async ({ enabled, active, text }) => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        rpc: {
          setSlowMode: async ({ enabled }) => ({ enabled }),
          getState: async () => ({
            fastModeEnabled: enabled,
            fastModeActive: active,
            sessionId: "session",
          }),
          setFastMode: async ({ enabled: next }) => ({ enabled: next, active: next }),
        },
      });
      await controller.refresh();
      render(
        <ModeControls
          actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
          model={{
            snapshot: controller.getSnapshot(),
            browserVisibility: null,
            busyMode: null,
            error: null,
          }}
        />,
      );
      expect(screen.getByText(text, { exact: true })).toBeTruthy();
      controller.dispose();
    },
  );

  test("a reply the app does not recognise reads Sent to omp, then omp's own words", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: gatewayAnswering(() => unknownReply(["This output is opaque to the view."])),
    });
    await controller.request({ mode: "computer", scope: "session", requested: true });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );
    expect(
      screen.getByText("Sent to omp. This output is opaque to the view.", {
        exact: true,
      }),
    ).toBeTruthy();
    controller.dispose();
  });

  test("fast mode reads Checking with omp until omp answers", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: () => new Promise<never>(() => undefined),
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );
    expect(screen.getByText("Checking with omp…", { exact: true })).toBeTruthy();
    const fast = within(screen.getByRole("group", { name: "Fast mode controls" }));
    expect(fast.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(fast.getByRole("button", { name: "Turn off" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    controller.dispose();
  });
});

describe("a mode omp does not report", () => {
  test("neither button is set until the person chooses one, and the status line says why", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        change: async () => {
          throw new Error("The command was not expected in this test.");
        },
      },
    });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: controller.getSnapshot(),
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );

    for (const name of ["Computer use controls", "Extended context controls"]) {
      const controls = within(screen.getByRole("group", { name }));
      expect(controls.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(controls.getByRole("button", { name: "Turn off" }).getAttribute("aria-pressed")).toBe(
        "false",
      );
    }
    expect(
      screen.getAllByText(
        "omp does not report whether this is on. Choose Turn on or Turn off for this chat.",
        { exact: true },
      ),
    ).toHaveLength(2);
    controller.dispose();
  });

  test("a failed Fast change keeps the last value omp reported, stays enabled, and offers Try again", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: async () => ({
          fastModeEnabled: false,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: async () => {
          throw new Error("omp did not answer the Fast mode change.");
        },
      },
    });
    await controller.refresh();
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);

    const fast = within(screen.getByRole("group", { name: "Fast mode controls" }));
    fireEvent.click(fast.getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("Fast mode could not be changed.")).toBeTruthy();
    expect(
      screen.getByText("The app could not reach omp. Try again.", { exact: true }),
    ).toBeTruthy();
    expect(screen.getByText("Off", { exact: true })).toBeTruthy();
    expect(fast.getByRole("button", { name: "Turn off" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(fast.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(fast.getByRole("button", { name: "Turn on" }).hasAttribute("disabled")).toBe(false);
    expect(fast.getByRole("button", { name: "Turn off" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    controller.dispose();
  });

  test("a failed Fast change before omp has reported anything selects neither button", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: () => Promise.withResolvers<never>().promise,
        setFastMode: async () => {
          throw new Error("omp did not answer the Fast mode change.");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);

    const fast = within(screen.getByRole("group", { name: "Fast mode controls" }));
    fireEvent.click(fast.getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("Fast mode could not be changed.")).toBeTruthy();
    expect(fast.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(fast.getByRole("button", { name: "Turn off" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(fast.getByRole("button", { name: "Turn on" }).hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText("omp has not reported Fast mode yet. Refresh status to check it.", {
        exact: true,
      }),
    ).toBeTruthy();
    controller.dispose();
  });
});
