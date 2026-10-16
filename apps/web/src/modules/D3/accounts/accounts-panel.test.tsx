import type { RedactedProviderAccount } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AccountSelectorState } from "../contract";
import type { ProviderAccountActionFailure, ProviderAccountsController } from "./accounts";
import { ProviderAccountsPanel } from "./accounts-panel";

afterEach(() => cleanup());

const account: RedactedProviderAccount = {
  id: "opaque-account-id",
  providerId: "provider-a",
  label: "Redacted account",
  active: false,
  source: "oauth",
};

function readyState(accounts: readonly RedactedProviderAccount[]): AccountSelectorState {
  return {
    state: "ready",
    providerId: "provider-a",
    accounts: [...accounts],
    selectedAccountId: null,
  };
}

function controller(
  listedAccount: RedactedProviderAccount = account,
  load?: () => Promise<AccountSelectorState>,
  actions: Partial<Pick<ProviderAccountsController, "logout" | "pin" | "resetUsage">> = {},
): ProviderAccountsController {
  let state: AccountSelectorState = { state: "loading", providerId: "provider-a" };
  let actionFailure: ProviderAccountActionFailure | null = null;
  return {
    actionFailure: () => actionFailure,
    clearActionFailure: () => {
      actionFailure = null;
    },
    getState: () => state,
    select: (accountId) => {
      if (state.state === "ready") state = { ...state, selectedAccountId: accountId };
    },
    clear: () => {
      if (state.state === "ready") state = { ...state, selectedAccountId: null };
    },
    reload: vi.fn(async () => {
      state = load ? await load() : readyState([listedAccount]);
      return state;
    }),
    logout: actions.logout ?? vi.fn(async () => true),
    pin: actions.pin ?? vi.fn(async () => undefined),
    resetUsage:
      actions.resetUsage ??
      vi.fn(async () => {
        actionFailure = {
          action: "reset",
          error: {
            code: "unavailable",
            message: "Usage reset is unsupported.",
            retryable: false,
          },
        };
        return false;
      }),
  };
}

describe("ProviderAccountsPanel", () => {
  test("keeps the list visible when reset fails and supports dismissal and other actions", async () => {
    const accounts = controller();
    render(<ProviderAccountsPanel accounts={accounts} available />);
    expect(await screen.findByText("Redacted account")).toBeTruthy();
    expect(screen.getByText("provider sign-in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Redacted account/ }));
    await waitFor(() =>
      expect(accounts.getState()).toMatchObject({ selectedAccountId: account.id }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Use for this chat" }));
    await waitFor(() =>
      expect(accounts.pin).toHaveBeenCalledWith(account, expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reset usage" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    await waitFor(() =>
      expect(accounts.resetUsage).toHaveBeenCalledWith(account, expect.any(AbortSignal)),
    );
    const error = await screen.findByRole("alert");
    expect(error.textContent).toMatch(/omp can't reset usage from here/i);
    expect(await screen.findByText("Redacted account")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() =>
      expect(accounts.logout).toHaveBeenCalledWith(account, expect.any(AbortSignal)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(accounts.getState()).toMatchObject({ selectedAccountId: null }));
  });
  test("shows the loading state while the account request remains pending", () => {
    const pending = new Promise<AccountSelectorState>(() => {});
    render(<ProviderAccountsPanel accounts={controller(account, () => pending)} available />);
    expect(screen.getByRole("status").textContent).toBe("Loading provider accounts…");
  });

  test("shows the empty state when no provider accounts exist", async () => {
    render(
      <ProviderAccountsPanel
        accounts={controller(account, async () => ({ state: "empty", providerId: "provider-a" }))}
        available
      />,
    );
    expect(await screen.findByText("No saved provider accounts")).toBeTruthy();
  });

  test("retries account-list failures", async () => {
    let attempts = 0;
    const accounts = controller(account, async () => {
      attempts += 1;
      return attempts === 1
        ? {
            state: "error",
            providerId: "provider-a",
            error: { code: "conflict", message: "safe conflict", retryable: true },
          }
        : {
            state: "ready",
            providerId: "provider-a",
            accounts: [account],
            selectedAccountId: null,
          };
    });
    render(<ProviderAccountsPanel accounts={accounts} available />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Redacted account")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  test("replaces stale rows when a new chat supplies a controller", async () => {
    const anotherAccount: RedactedProviderAccount = {
      ...account,
      id: "second-account",
      label: "Another account",
    };
    const view = render(<ProviderAccountsPanel accounts={controller()} available />);
    expect(await screen.findByText("Redacted account")).toBeTruthy();
    view.rerender(<ProviderAccountsPanel accounts={controller(anotherAccount)} available />);
    expect(await screen.findByText("Another account")).toBeTruthy();
    expect(screen.queryByText("Redacted account")).toBeNull();
  });

  test("aborts an action when its panel unmounts without retaining an action failure", async () => {
    let signal: AbortSignal | undefined;
    const pin = vi.fn((_account: RedactedProviderAccount, signalArg?: AbortSignal) => {
      signal = signalArg;
      return new Promise<void>(() => {});
    });
    const accounts = controller(account, undefined, { pin });
    const view = render(<ProviderAccountsPanel accounts={accounts} available />);
    expect(await screen.findByText("Redacted account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use for this chat" }));
    await waitFor(() => expect(pin).toHaveBeenCalledOnce());
    expect(await screen.findByText("Updating provider account…")).toBeTruthy();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(accounts.actionFailure()).toBeNull();
  });

  test("does not show pin for API-key accounts", async () => {
    const apiKeyAccount: RedactedProviderAccount = {
      ...account,
      source: "agent-db",
      label: "API key",
    };
    render(<ProviderAccountsPanel accounts={controller(apiKeyAccount)} available />);
    expect(await screen.findByText("API key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use for this chat" })).toBeNull();
  });

  test("explains unavailable controls without making a host call", () => {
    const accounts = controller();
    render(<ProviderAccountsPanel accounts={accounts} available={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/unavailable for this session/i);
    expect(accounts.reload).not.toHaveBeenCalled();
  });
});
