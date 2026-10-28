import {
  type CapabilityMap,
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  type ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModeCommandGateway } from "../contract";
import { ModeController } from "./controller";
import { ConnectedModeControls, ModeControls } from "./view";

const threadId = "d7-wording-view" as ThreadId;

/** Words a person should not read in the controls: the app's own names, and omp's internal ones. */
const INTERNAL_WORDS =
  /RPC|gateway|capabilit|fallback|baseline|tier|command|prelude|slash|session|conversation|typed|probe|policy|detail|configured|flex|execution-mode|standard path|\/[a-z]/i;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "omp" }),
    ...overrides,
  };
}

/** The typed outcome omp gives a change it made: exactly the value the request asked for. */
function appliedFor(request: ModeChangeRequest): ModeChangeResult {
  return request.mode === "browser"
    ? { outcome: "applied", mode: "browser", visibility: request.visibility }
    : { outcome: "applied", mode: request.mode, on: request.requested };
}

/** A reply the app does not recognise, carrying omp's words as sent (none when `words` is empty). */
function unknownReply(words: readonly string[]): ModeChangeResult {
  return { outcome: "unknown", mode: "slow", outputs: [...words] };
}

/** A gateway that answers each change with `answer(request)`. */
function gatewayAnswering(
  answer: (request: ModeChangeRequest) => ModeChangeResult,
): ModeCommandGateway {
  return { change: async ({ request }) => answer(request) };
}

/** A gateway that answers every change with a reply the app does not recognise, with no words. */
const silent: ModeCommandGateway = gatewayAnswering(() => unknownReply([]));

const rpc = {
  setSlowMode: async ({ enabled }: { readonly enabled: boolean }) => ({ enabled }),
  getState: async () => ({ sessionId: "session", fastModeEnabled: false, fastModeActive: false }),
  setFastMode: async ({ enabled }: { readonly enabled: boolean }) => ({
    enabled,
    active: enabled,
  }),
};

afterEach(cleanup);

/** The controls as the view shows them for the controller's snapshot, with no change in progress. */
function renderControls(controller: ModeController) {
  return render(
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
}

/**
 * The controls' text as a person reads the words the app wrote: omp's own words after "Sent to omp." are left
 * out, because they are the one place omp's text is shown (a reply the app does not recognise).
 */
function appWrittenText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const status of copy.querySelectorAll('[role="status"]')) {
    if ((status.textContent ?? "").startsWith("Sent to omp.")) status.textContent = "Sent to omp.";
  }
  return copy.textContent ?? "";
}

function controlsOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>("[data-d7-mode-controls]");
  if (root === null) throw new Error("The execution mode controls are not rendered.");
  return root;
}

describe("plain words in the mode descriptions", () => {
  test.each([
    "Choose how omp runs. Settings marked as saved apply to every chat.",
    "Choose whether browser work runs with a visible window or without one. Saved for every chat.",
    "Allow omp to use the computer-control tool in this chat.",
    "Use larger context windows where the model supports them. This can cost more. Saved for every chat.",
    "Get faster replies when the model supports it.",
    "Use the provider's slower, lower-cost option when it has one.",
    "Replies run as usual when none of the settings above is on.",
    "Always available.",
  ])("shows %s", (sentence) => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    renderControls(controller);
    expect(screen.getByText(sentence)).toBeTruthy();
    controller.dispose();
  });

  test("the first state of the controls uses no internal word and no word for conversation or session", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    const { container } = renderControls(controller);
    expect(appWrittenText(controlsOf(container))).not.toMatch(INTERNAL_WORDS);
    controller.dispose();
  });
});

describe("plain words in the status lines", () => {
  test("says the chat is still connecting when a mode has no state yet", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    render(
      <ModeControls
        actions={{ onRequest: vi.fn(), onBrowserVisibility: vi.fn(), onRefresh: vi.fn() }}
        model={{
          snapshot: { ...controller.getSnapshot(), modes: {} },
          browserVisibility: null,
          busyMode: null,
          error: null,
        }}
      />,
    );
    expect(screen.getAllByText("Waiting for the chat to connect.").length).toBeGreaterThan(0);
    controller.dispose();
  });

  test("says what was set for a browser window omp does not report", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({ state: "fallback", via: "host" }),
      }),
      gateway: gatewayAnswering(appliedFor),
    });
    await controller.requestBrowserVisibility("visible");
    renderControls(controller);
    expect(
      screen.getByText(
        "Set for this chat. omp does not say whether its browser window is visible.",
      ),
    ).toBeTruthy();
    controller.dispose();
  });

  test("a reply the app does not recognise reads Sent to omp, then omp's words exactly as omp wrote them", async () => {
    const reply = "Computer use is on for this chat.";
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: gatewayAnswering(() => unknownReply([reply])),
    });
    await controller.request({ mode: "computer", scope: "session", requested: true });
    renderControls(controller);
    expect(screen.getByText(`Sent to omp. ${reply}`, { exact: true })).toBeTruthy();
    controller.dispose();
  });

  test("shows a missing mode as one plain sentence, with no Not available. in front of it", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    const { container } = renderControls(controller);
    expect(
      screen.getByText("Fast mode is not available until the app is connected to omp.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(controlsOf(container).textContent).not.toContain("Not available.");
    controller.dispose();
  });

  test("keeps the server's own detail off every row when omp's capabilities report it", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({
          state: "unavailable",
          via: "host",
          detail: "omp did not return a command response before the probe timed out",
        }),
        "omp.cmd.get_state": CapabilityStatus.parse({
          state: "unavailable",
          via: "omp",
          detail: "Unknown command: get_state (omp-v18.6.1:docs/rpc.md:141-149)",
        }),
      }),
      gateway: silent,
      rpc,
    });
    const { container } = render(<ConnectedModeControls controller={controller} />);
    expect(await screen.findByText("The settings could not be loaded")).toBeTruthy();
    const text = controlsOf(container).textContent ?? "";
    expect(text).not.toContain("probe");
    expect(text).not.toContain("Unknown command");
    expect(text).not.toContain("docs/rpc");
    expect(text).toContain("omp cannot report these settings in this chat.");
    controller.dispose();
  });
});

describe("plain words in the failure messages", () => {
  test.each([
    { mode: "Computer use", group: "Computer use controls" },
    { mode: "Extended context", group: "Extended context controls" },
  ])(
    "names $mode in a failed change, and says the app could not reach omp",
    async ({ mode, group }) => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: {
          change: async () => {
            throw new Error("the connection dropped");
          },
        },
      });
      render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
      fireEvent.click(
        within(screen.getByRole("group", { name: group })).getByRole("button", { name: "Turn on" }),
      );
      expect(await screen.findByText(`${mode} could not be changed.`)).toBeTruthy();
      expect(
        screen.getByText("The app could not reach omp. Try again.", { exact: true }),
      ).toBeTruthy();
      controller.dispose();
    },
  );

  test("names Browser use in a failed change to the browser window", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        change: async () => {
          throw new Error("the connection dropped");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Visible window" }));
    expect(await screen.findByText("Browser use could not be changed.")).toBeTruthy();
    controller.dispose();
  });

  test("names Fast mode in a failed Fast change", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        ...rpc,
        setFastMode: async () => {
          throw new Error("the connection dropped");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Fast mode controls" })).getByRole("button", {
        name: "Turn on",
      }),
    );
    expect(await screen.findByText("Fast mode could not be changed.")).toBeTruthy();
    expect(
      screen.getByText("The app could not reach omp. Try again.", { exact: true }),
    ).toBeTruthy();
    controller.dispose();
  });

  test("says the settings could not be loaded, and that the app could not reach omp, when reading them fails", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
      rpc: {
        ...rpc,
        getState: async () => {
          throw new Error("the connection dropped");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} />);
    expect(await screen.findByText("The settings could not be loaded")).toBeTruthy();
    expect(
      screen.getByText("The app could not reach omp. Try again.", { exact: true }),
    ).toBeTruthy();
    controller.dispose();
  });

  test("says the app could not reach omp when a failed result carries no reason", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    vi.spyOn(controller, "request").mockResolvedValue({
      ok: false,
      command: "/computer on",
      mode: "computer",
      state: "unavailable",
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    const computer = screen.getByRole("group", { name: "Computer use controls" });
    fireEvent.click(within(computer).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Computer use could not be changed.")).toBeTruthy();
    expect(
      screen.getByText("The app could not reach omp. Try again.", { exact: true }),
    ).toBeTruthy();
    controller.dispose();
  });

  test("says the app could not reach omp when the request fails with something other than an error", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: silent,
    });
    vi.spyOn(controller, "request").mockRejectedValue("boom");
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    const computer = screen.getByRole("group", { name: "Computer use controls" });
    fireEvent.click(within(computer).getByRole("button", { name: "Turn on" }));
    expect(
      await screen.findByText("The app could not reach omp. Try again.", { exact: true }),
    ).toBeTruthy();
    controller.dispose();
  });
});

describe("a failed change shows its message once", () => {
  test("the message sits in the error block only, not again on the row", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        change: async () => {
          throw new Error("the connection dropped");
        },
      },
    });
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    const computer = screen.getByRole("group", { name: "Computer use controls" });
    fireEvent.click(within(computer).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Computer use could not be changed.")).toBeTruthy();
    expect(
      screen.getAllByText("The app could not reach omp. Try again.", { exact: true }),
    ).toHaveLength(1);
    controller.dispose();
  });
});

describe("plain words around omp's typed outcomes", () => {
  test("every typed outcome reads in plain words, and no omp words are shown", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: gatewayAnswering(appliedFor),
    });
    await controller.request({ mode: "computer", scope: "session", requested: true });
    await controller.request({ mode: "extended-context", scope: "session", requested: true });
    await controller.requestBrowserVisibility("visible");
    const { container } = renderControls(controller);
    const statuses = screen.getAllByRole("status").map((element) => element.textContent ?? "");
    expect(statuses.filter((text) => text.startsWith("Sent to omp."))).toHaveLength(0);
    expect(appWrittenText(controlsOf(container))).not.toMatch(INTERNAL_WORDS);
    controller.dispose();
  });
});
