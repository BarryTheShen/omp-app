import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  ProviderAccountStore,
  type RedactedProviderAccount,
  type ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import type { DialogHost } from "../../U4/contract";
import type { AccountSelector, AccountSelectorState } from "../contract";

export interface ProviderAccountsOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly providerId: string;
  readonly capabilities: CapabilityMap;
  readonly dialogs: Pick<DialogHost, "confirm">;
}

export type ProviderAccountAction = "logout" | "pin" | "reset";
export interface ProviderAccountActionFailure {
  readonly action: ProviderAccountAction;
  readonly error: AppError;
}

export interface ProviderAccountsController extends AccountSelector {
  readonly reload: (signal?: AbortSignal) => Promise<AccountSelectorState>;
  readonly logout: (account: RedactedProviderAccount, signal?: AbortSignal) => Promise<boolean>;
  readonly pin: (account: RedactedProviderAccount, signal?: AbortSignal) => Promise<void>;
  readonly resetUsage: (account: RedactedProviderAccount, signal?: AbortSignal) => Promise<boolean>;
  readonly actionFailure: () => ProviderAccountActionFailure | null;
  readonly clearActionFailure: () => void;
}

const CAPABILITY: CapabilityKey = "host.provider-accounts";

function appError(error: unknown, fallback: string): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: fallback, retryable: false };
}

function actionId(action: string): UiRequestId {
  return UiRequestId.parse(`app-d3-account-${action}-${crypto.randomUUID()}`);
}

function unavailable(): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: "Provider account controls are unavailable for this session.",
    retryable: false,
    capability: CAPABILITY,
  });
}

function pinUnavailable(): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: "Only provider sign-ins can be used for a single chat.",
    retryable: false,
  });
}

/** The browser receives only A1.11's redacted account DTOs; credentials stay on the server. */
export function createProviderAccounts(
  options: ProviderAccountsOptions,
): ProviderAccountsController {
  const port = options.client.port(ProviderAccountStore);
  const capability = options.capabilities[CAPABILITY];
  let state: AccountSelectorState = { state: "loading", providerId: options.providerId };
  let selectedAccountId: string | null = null;
  let failedAction: ProviderAccountActionFailure | null = null;

  const requireCapability = (): void => {
    if (capability?.state !== "available") throw unavailable();
  };

  const load = async (signal?: AbortSignal): Promise<AccountSelectorState> => {
    failedAction = null;
    try {
      requireCapability();
      const result = await port.listAccounts(
        { providerId: options.providerId, sessionId: options.threadId },
        { signal },
      );
      if (result.providerId !== options.providerId) {
        throw new AppFailure({
          code: "invalid_args",
          message: "The account list did not match the selected provider.",
          retryable: false,
        });
      }
      const accounts = result.accounts;
      selectedAccountId = accounts.some((account) => account.id === selectedAccountId)
        ? selectedAccountId
        : (accounts.find((account) => account.active)?.id ?? null);
      state =
        accounts.length === 0
          ? { state: "empty", providerId: options.providerId }
          : { state: "ready", providerId: options.providerId, accounts, selectedAccountId };
    } catch (error) {
      if (signal?.aborted) return state;
      const failure = appError(error, "Could not load provider accounts.");
      state = { state: "error", providerId: options.providerId, error: failure };
    }
    return state;
  };

  const confirm = async (
    action: "logout" | "reset",
    account: RedactedProviderAccount,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const message =
      action === "logout"
        ? `Remove the saved ${account.label} login from this device? This does not revoke access with the provider.`
        : `Reset usage tracking for ${account.label}?`;
    return options.dialogs.confirm(
      {
        kind: "confirm",
        id: actionId(action),
        title: action === "logout" ? "Log out of provider" : "Reset provider usage",
        message,
      },
      { threadId: options.threadId, origin: "app", signal },
    );
  };
  const removeAccountFromState = (accountId: string): void => {
    if (state.state !== "ready") return;
    const accounts = state.accounts.filter((candidate) => candidate.id !== accountId);
    selectedAccountId = accounts.some((candidate) => candidate.id === selectedAccountId)
      ? selectedAccountId
      : null;
    state =
      accounts.length === 0
        ? { state: "empty", providerId: options.providerId }
        : { state: "ready", providerId: options.providerId, accounts, selectedAccountId };
  };

  const actionArgs = (account: RedactedProviderAccount) => ({
    providerId: options.providerId,
    accountId: account.id,
  });

  const recordFailure = (action: ProviderAccountAction, error: unknown, fallback: string): void => {
    failedAction = { action, error: appError(error, fallback) };
  };

  return {
    actionFailure: () => failedAction,
    clearActionFailure: () => {
      failedAction = null;
    },
    getState: () => state,
    select(accountId) {
      if (state.state !== "ready" || !state.accounts.some((account) => account.id === accountId))
        return;
      selectedAccountId = accountId;
      state = { ...state, selectedAccountId };
    },
    clear() {
      selectedAccountId = null;
      if (state.state === "ready") state = { ...state, selectedAccountId: null };
    },
    reload: load,
    async logout(account, signal) {
      failedAction = null;
      try {
        requireCapability();
        if (!(await confirm("logout", account, signal))) return false;
        await port.logout(actionArgs(account), { signal });
        failedAction = null;
        removeAccountFromState(account.id);
        return true;
      } catch (error) {
        if (!signal?.aborted) recordFailure("logout", error, "Could not log out of the provider.");
        return false;
      }
    },
    async pin(account, signal) {
      failedAction = null;
      try {
        requireCapability();
        if (account.source !== "oauth") throw pinUnavailable();
        await port.pin({ ...actionArgs(account), sessionId: options.threadId }, { signal });
        selectedAccountId = account.id;
        failedAction = null;
        await load(signal);
      } catch (error) {
        if (!signal?.aborted) recordFailure("pin", error, "Could not pin the provider account.");
      }
    },
    async resetUsage(account, signal) {
      failedAction = null;
      try {
        requireCapability();
        if (!(await confirm("reset", account, signal))) return false;
        await port.resetUsage(actionArgs(account), { signal });
        failedAction = null;
        await load(signal);
        return true;
      } catch (error) {
        if (!signal?.aborted) recordFailure("reset", error, "Could not reset provider usage.");
        return false;
      }
    },
  };
}
