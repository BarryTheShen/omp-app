import { type CapabilityMap, CapabilityStatus, type ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { GetStateResult, ModeRpc } from "../contract";
import { ModeController } from "./controller";
import { SLOW_UNSUPPORTED_TEXT } from "./slow";
import { ConnectedModeControls } from "./view";

afterEach(cleanup);

const threadId = "d7-slow-row-thread" as ThreadId;

const SLOW_BASE = "Use the provider's slower, lower-cost option when it has one.";

function capabilities(): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_slow_mode": CapabilityStatus.parse({ state: "available", via: "omp" }),
  };
}

function stateWith(slow: Partial<GetStateResult>): GetStateResult {
  return { sessionId: "session", fastModeEnabled: false, fastModeActive: false, ...slow };
}

/** A controller whose mode RPC answers get_state with `state()` and set_slow_mode with `setSlow`. */
function controllerWith(
  state: () => GetStateResult,
  setSlow: (enabled: boolean) => Promise<{ readonly enabled: boolean }> = async (enabled) => ({
    enabled,
  }),
): ModeController {
  const rpc: ModeRpc = {
    getState: async () => state(),
    setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
    setSlowMode: async ({ enabled }) => setSlow(enabled),
  };
  return new ModeController({ threadId, capabilities: capabilities(), rpc });
}

describe("the Slow mode row as omp reports it", () => {
  test("a model without slow mode shows both buttons disabled, with the plain reason", async () => {
    const controller = controllerWith(() =>
      stateWith({ slowModeSupported: false, slowModeEnabled: false }),
    );
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    expect(await screen.findByText(SLOW_UNSUPPORTED_TEXT, { exact: true })).toBeTruthy();
    expect(slow.getByRole("button", { name: "Turn on" }).hasAttribute("disabled")).toBe(true);
    expect(slow.getByRole("button", { name: "Turn off" }).hasAttribute("disabled")).toBe(true);
    controller.dispose();
  });

  test("a model whose account is at the wrap-up stage reads On, with the wrap-up sentence on the same line", async () => {
    const controller = controllerWith(() =>
      stateWith({
        slowModeSupported: true,
        slowModeEnabled: true,
        slowModeScope: "global",
        usageLimit: { stage: "wrap_up", extraUsage: false },
      }),
    );
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    expect(
      await screen.findByText(
        "On. Your usage limit is reached. Requests get a short wrap-up allowance, then wait until your limit resets.",
        { exact: true },
      ),
    ).toBeTruthy();
    expect(slow.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe("true");
    expect(slow.getByRole("button", { name: "Turn off" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    controller.dispose();
  });

  test("the low-priority stage shows its reset time and the allowance left, with the choice On", async () => {
    const controller = controllerWith(() =>
      stateWith({
        slowModeSupported: true,
        slowModeEnabled: true,
        slowModeScope: "global",
        usageLimit: { stage: "low_priority", resetsAtSec: 1_791_720_000, allowanceLeftPercent: 62 },
      }),
    );
    render(<ConnectedModeControls controller={controller} />);
    expect(
      await screen.findByText(
        /^On\. Requests run at low priority until your limit resets (at|on) .+\. 62% of the low-priority allowance is left\.$/,
      ),
    ).toBeTruthy();
    controller.dispose();
  });

  test("a read that does not say whether slow mode is offered says omp has not reported it, with neither choice set", async () => {
    const controller = controllerWith(() => stateWith({}));
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    expect(
      await screen.findByText("omp has not reported Slow mode yet. Refresh status to check it.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(slow.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    controller.dispose();
  });

  test("while omp has a change, the line says the app is checking with omp", async () => {
    const controller = controllerWith(
      () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
      () => new Promise<never>(() => undefined),
    );
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    await waitFor(() => expect(controller.getSnapshot().modes.slow?.state).toBe("known"));
    fireEvent.click(slow.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Checking with omp…", { exact: true })).toBeTruthy();
    controller.dispose();
  });

  test("a failed Slow mode change names Slow mode, and says omp did not make the change", async () => {
    const controller = controllerWith(
      () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
      async () => {
        throw new Error("the connection dropped");
      },
    );
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    await waitFor(() => expect(controller.getSnapshot().modes.slow?.state).toBe("known"));
    fireEvent.click(slow.getByRole("button", { name: "Turn on" }));
    expect(
      await screen.findByText("Slow mode could not be changed.", { exact: true }),
    ).toBeTruthy();
    expect(
      screen.getByText("omp did not make the change. Try again.", { exact: true }),
    ).toBeTruthy();
    expect(slow.getByRole("button", { name: "Turn on" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    controller.dispose();
  });

  test("a model whose slow mode is saved in the settings says so in the row", async () => {
    const controller = controllerWith(() =>
      stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" }),
    );
    render(<ConnectedModeControls controller={controller} />);
    expect(
      await screen.findByText(`${SLOW_BASE} Saved for every chat.`, { exact: true }),
    ).toBeTruthy();
    expect(
      screen.queryByText(`${SLOW_BASE} Applies to this chat only.`, { exact: true }),
    ).toBeNull();
    controller.dispose();
  });

  test("a model whose slow mode is for this chat says so, and still says it while a change is sent", async () => {
    let finishChange: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finishChange = resolve;
    });
    const controller = controllerWith(
      () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
      async (enabled) => {
        await pending;
        return { enabled };
      },
    );
    render(<ConnectedModeControls controller={controller} />);
    const slow = within(screen.getByRole("group", { name: "Slow mode controls" }));
    const sentence = `${SLOW_BASE} Applies to this chat only.`;
    expect(await screen.findByText(sentence, { exact: true })).toBeTruthy();
    fireEvent.click(slow.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Checking with omp…", { exact: true })).toBeTruthy();
    expect(screen.getByText(sentence, { exact: true })).toBeTruthy();
    expect(screen.queryByText(`${SLOW_BASE} Saved for every chat.`, { exact: true })).toBeNull();
    finishChange();
    controller.dispose();
  });

  test("before omp has reported Slow mode, the row names no place", () => {
    const controller = controllerWith(() =>
      stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
    );
    render(<ConnectedModeControls controller={controller} refreshOnMount={false} />);
    expect(screen.getByText(SLOW_BASE, { exact: true })).toBeTruthy();
    expect(
      screen.queryByText(`${SLOW_BASE} Applies to this chat only.`, { exact: true }),
    ).toBeNull();
    controller.dispose();
  });

  test("a model without slow mode names no place for it", async () => {
    const controller = controllerWith(() =>
      stateWith({ slowModeSupported: false, slowModeEnabled: false, slowModeScope: "global" }),
    );
    render(<ConnectedModeControls controller={controller} />);
    expect(await screen.findByText(SLOW_UNSUPPORTED_TEXT, { exact: true })).toBeTruthy();
    expect(screen.getByText(SLOW_BASE, { exact: true })).toBeTruthy();
    expect(screen.queryByText(`${SLOW_BASE} Saved for every chat.`, { exact: true })).toBeNull();
    controller.dispose();
  });
});
