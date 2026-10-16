import { AppFailure, type CapabilityMap } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderSetupController, SetupCommand, SetupOutcome } from "./setup";
import { SETUP_CAPABILITIES, SETUP_COMMANDS } from "./setup";
import { ProviderSetupPanel } from "./setup-panel";

afterEach(cleanup);

function controller(overrides: Partial<ProviderSetupController> = {}): ProviderSetupController {
  const capabilities: CapabilityMap = {
    [SETUP_CAPABILITIES.commandGateway]: { state: "available" as const, via: "host" as const },
    [SETUP_CAPABILITIES.setupCommands]: { state: "available" as const, via: "upstream" as const },
  };
  return {
    capabilities: () => capabilities,
    run: vi.fn(
      async (command): Promise<SetupOutcome> => ({
        state: "completed",
        command,
        reloadRequired: true,
      }),
    ),
    setup: vi.fn(),
    setupProviders: vi.fn(),
    wizardAvailable: () => false,
    setupCommandsAvailable: () => true,
    openWizard: vi.fn(),
    ...overrides,
  };
}

describe("ProviderSetupPanel", () => {
  test("runs the single setup-providers action and announces a reload outcome", async () => {
    const setup = controller();
    render(<ProviderSetupPanel setup={setup} />);
    expect(screen.queryByRole("button", { name: "Run setup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up providers" }));
    await waitFor(() =>
      expect(setup.run).toHaveBeenCalledWith(SETUP_COMMANDS.providers, expect.anything()),
    );
    expect(
      await screen.findByText("Provider setup finished. Reload to use the new settings."),
    ).toBeTruthy();
  });

  test("shows the capability-gated wizard reason and disabled control", () => {
    const setup = controller();
    render(<ProviderSetupPanel setup={setup} />);
    expect(screen.getByText("omp only offers the setup wizard in its terminal.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open setup wizard" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(setup.openWizard).not.toHaveBeenCalled();
  });

  test("disables setup commands with the terminal-only reason", () => {
    const setup = controller({ setupCommandsAvailable: () => false });
    render(<ProviderSetupPanel setup={setup} />);
    expect(screen.getByText("omp can only open provider setup in its terminal.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up providers" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(setup.run).not.toHaveBeenCalled();
  });

  test("shows setup errors and lets the person retry", async () => {
    let attempts = 0;
    const setup = controller({
      run: vi.fn(async (command) => {
        attempts += 1;
        return attempts === 1
          ? {
              state: "error" as const,
              command,
              error: new AppFailure({
                code: "conflict",
                message: "safe conflict",
                retryable: true,
              }),
            }
          : { state: "completed" as const, command, reloadRequired: true as const };
      }),
    });
    render(<ProviderSetupPanel setup={setup} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up providers" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Provider setup finished. Reload to use the new settings."),
    ).toBeTruthy();
    expect(setup.run).toHaveBeenCalledTimes(2);
  });

  test("shows provider setup as unavailable when the gateway is absent", () => {
    const setup = controller({
      capabilities: () => ({
        [SETUP_CAPABILITIES.setupCommands]: {
          state: "available" as const,
          via: "upstream" as const,
        },
      }),
    });
    render(<ProviderSetupPanel setup={setup} />);
    expect(screen.getByText("Provider setup is unavailable for this session.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up providers" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
  test("opens the injected wizard only when it is available", async () => {
    const outcome: SetupOutcome = {
      state: "completed",
      command: SETUP_COMMANDS.providers,
      reloadRequired: true,
    };
    const openWizard = vi.fn(async () => outcome);
    render(<ProviderSetupPanel setup={controller({ wizardAvailable: () => true, openWizard })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open setup wizard" }));
    expect(
      await screen.findByText("Provider setup finished. Reload to use the new settings."),
    ).toBeTruthy();
    expect(openWizard).toHaveBeenCalledOnce();
  });

  test("aborts setup work when the panel unmounts", async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn((_command: SetupCommand, options?: { readonly signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<SetupOutcome>(() => {});
    });
    const view = render(<ProviderSetupPanel setup={controller({ run })} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up providers" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
